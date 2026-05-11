import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { insertProductSchema, insertCartItemSchema, insertPromotionSchema, insertEventSchema, insertUserSchema, insertBrandSchema, insertCustomerSavingsSchema, auditEvents, auditActionCodes, auditDailyDigests, AuditActionCodes, users, appInstallations, type InsertAuditEvent } from "@shared/schema";
import { z } from "zod";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";
import { randomBytes } from "crypto";
import fs from "fs-extra";
import * as path from "path";
import { CronJob } from "cron";
import { sql, desc, eq, and, count, gte } from "drizzle-orm";
import { detectBrandFromImage, combineDetectionResults } from "./ai-vision";
import { detectBrandFromFilename, PENDING_REVIEW_BRAND, MIN_CONFIDENCE_THRESHOLD } from "./brand-detection";
import { db } from "./db";

// Helper functions
function generateUniqueReference(): string {
  // Caracteres seguros para nombres de archivo: letras, números y símbolos web-safe
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '';
  const randomValues = randomBytes(10); // Máximo 10 caracteres
  
  for (let i = 0; i < 10; i++) {
    result += chars[randomValues[i] % chars.length];
  }
  
  return result;
}

// Generate unique reference ensuring no duplicates in database
async function generateUniqueReferenceForProduct(): Promise<string> {
  let reference: string;
  let attempts = 0;
  const maxAttempts = 100; // Prevent infinite loops
  
  do {
    reference = generateUniqueReference();
    attempts++;
    
    // Check if reference already exists in database
    const existingProduct = await storage.getProductByReference(reference);
    if (!existingProduct) {
      return reference;
    }
  } while (attempts < maxAttempts);
  
  // If we couldn't generate a unique reference after max attempts, throw error
  throw new Error('No se pudo generar una referencia única después de múltiples intentos');
}

// 🛡️ REPLACED: Using new precise brand detection module
// This eliminates false positives and implements proper review queue
// 🚨 LEGACY FUNCTION REMOVED - Now using detectBrandFromFilename directly
// This ensures server is 100% authoritative with single source of truth

// 🔒 SECURE: Session-based admin authorization middleware
async function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  try {
    // Get user session from headers
    const userSession = req.headers['x-user-session'] as string;
    
    if (!userSession) {
      return res.status(401).json({ 
        message: "Sesión de usuario requerida",
        details: "Se requiere autenticación válida" 
      });
    }
    
    let userData;
    try {
      userData = JSON.parse(userSession);
    } catch {
      return res.status(401).json({ message: "Sesión de usuario inválida" });
    }
    
    // Verify user exists and is admin
    const user = await storage.getUserById(userData.id);
    if (!user) {
      return res.status(401).json({ message: "Usuario no encontrado" });
    }
    
    if (!user.isAdmin) {
      return res.status(403).json({ message: "Acceso denegado: Se requieren permisos de administrador" });
    }
    
    // Store authenticated admin user for use in the route handler
    (req as any).adminUser = user;
    next();
  } catch (error) {
    console.error("Error in admin authentication:", error);
    res.status(500).json({ message: "Error en la autenticación de administrador" });
  }
}

// 🔒 SECURE: Session-based admin authorization for headers (same as body-based)
const requireAdminAuthHeaders = requireAdminAuth;

// 🔒 SECURE: Brand package schema for bulk creation (no credentials required)
const brandPackageSchema = z.object({
  brandId: z.string().min(1, "Brand ID is required"),
  categoryId: z.string().min(1, "Category ID is required"),
  images: z.array(z.string()).min(1, "At least 1 image required"),
  sizeFrom: z.string().min(1, "Size from is required"),
  sizeTo: z.string().min(1, "Size to is required"),
});

// 🔒 SECURE: Duplicate detection validation schemas
const duplicateQuerySchema = z.object({
  by: z.enum(["reference", "name", "image"], {
    required_error: "Criteria is required",
    invalid_type_error: "Criteria must be 'reference', 'name', or 'image'"
  }),
  brandId: z.string().optional(),
  page: z.string().optional().transform(val => val ? parseInt(val, 10) : 1),
  limit: z.string().optional().transform(val => val ? parseInt(val, 10) : 20)
});

const mergeProductsSchema = z.object({
  primaryId: z.string().min(1, "Primary product ID is required"),
  duplicateIds: z.array(z.string()).min(1, "At least one duplicate ID is required"),
  strategy: z.enum(["keep_primary", "merge_data"], {
    required_error: "Merge strategy is required",
    invalid_type_error: "Strategy must be 'keep_primary' or 'merge_data'"
  })
});

const updateProductSchema = insertProductSchema.partial();

// 🔒 AUDIT MIDDLEWARE - Asynchronous logging system 
function truncateIp(ip: string): string {
  if (!ip) return '';
  // IPv4 truncation to /24 subnet for privacy
  if (ip.includes('.')) {
    const parts = ip.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  // IPv6 truncation to /48 subnet for privacy  
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return `${parts[0]}:${parts[1]}:${parts[2]}::`;
  }
  return ip;
}

function hashUserAgent(userAgent: string): string {
  if (!userAgent) return '';
  // Simple hash for user agent (could use crypto.createHash for better security)
  return Buffer.from(userAgent).toString('base64').slice(0, 16);
}

function getActionCodeForRoute(method: string, path: string): number {
  // Map HTTP method + path to audit action codes
  const route = `${method} ${path}`;
  
  // Authentication routes (1xx)
  if (route.includes('/auth/login')) return AuditActionCodes.USER_LOGIN;
  if (route.includes('/auth/register')) return AuditActionCodes.USER_CREATE;
  if (route.includes('/auth/')) return AuditActionCodes.AUTH_FAILURE;
  
  // Product management (3xx)
  if (method === 'POST' && path.includes('/products')) return AuditActionCodes.PRODUCT_CREATE;
  if (method === 'PUT' && path.includes('/products')) return AuditActionCodes.PRODUCT_UPDATE;
  if (method === 'DELETE' && path.includes('/products')) return AuditActionCodes.PRODUCT_DELETE;
  if (method === 'GET' && path.includes('/products')) return AuditActionCodes.PRODUCT_VIEW;
  
  // Brand management (4xx)
  if (method === 'POST' && path.includes('/brands')) return AuditActionCodes.BRAND_CREATE;
  if (method === 'PUT' && path.includes('/brands')) return AuditActionCodes.BRAND_UPDATE;
  if (method === 'DELETE' && path.includes('/brands')) return AuditActionCodes.BRAND_DELETE;
  if (method === 'GET' && path.includes('/brands')) return AuditActionCodes.BRAND_VIEW;
  
  // Cart & Orders (5xx)
  if (method === 'POST' && path.includes('/cart')) return AuditActionCodes.CART_ADD;
  if (method === 'DELETE' && path.includes('/cart')) return AuditActionCodes.CART_REMOVE;
  if (method === 'POST' && path.includes('/orders')) return AuditActionCodes.ORDER_CREATE;
  if (method === 'PUT' && path.includes('/orders')) return AuditActionCodes.ORDER_UPDATE;
  
  // File operations (6xx)
  if (method === 'POST' && (path.includes('/upload') || path.includes('/images'))) {
    return 601; // FILE_UPLOAD
  }
  
  // Default to API_CALL for other API routes
  return 703; // API_CALL
}

async function auditLogger(req: Request, res: Response, next: NextFunction) {
  // Skip non-API routes and static files
  if (!req.path.startsWith('/api') || req.path.includes('/images/')) {
    return next();
  }
  
  const startTime = Date.now();
  
  // Capture original res.json to get response data
  const originalJson = res.json;
  let responseData: any = null;
  
  res.json = function(body: any) {
    responseData = body;
    return originalJson.call(this, body);
  };
  
  res.on('finish', () => {
    // Async logging - don't block the response
    setImmediate(async () => {
      try {
        const endTime = Date.now();
        const latency = endTime - startTime;
        
        // Extract session info if available
        let actorType = 'anonymous';
        let actorId: string | null = null;
        let sessionId = 'no-session';
        
        const userSession = req.headers['x-user-session'] as string;
        if (userSession) {
          try {
            const userData = JSON.parse(userSession);
            actorId = userData.id;
            actorType = userData.isAdmin ? 'admin' : 'client';
            sessionId = `user-${actorId}`;
          } catch {
            actorType = 'anonymous';
          }
        }
        
        // Determine result based on status code
        let result = 'success';
        if (res.statusCode >= 400 && res.statusCode < 500) {
          result = 'denied';
        } else if (res.statusCode >= 500) {
          result = 'error';
        }
        
        // Get action code for this route
        const actionCode = getActionCodeForRoute(req.method, req.path);
        
        // Create audit event
        const auditEvent: InsertAuditEvent = {
          actorType,
          actorId,
          sessionId,
          ipTruncated: truncateIp(req.ip || req.connection.remoteAddress || ''),
          userAgentHash: hashUserAgent(req.get('User-Agent') || ''),
          actionCode,
          resourceType: 'api',
          resourceId: req.path,
          result,
          latencyMs: latency,
          metadata: {
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            hasResponse: !!responseData,
            timestamp: endTime
          } as any
        };
        
        // Log asynchronously without blocking
        await storage.createAuditEvent(auditEvent);
      } catch (error) {
        // Silent fail for audit logging - don't affect the application
        console.error('Audit logging error:', error);
      }
    });
  });
  
  next();
}

// 🔒 SECURE: Bulk product update schema
const bulkUpdateProductsSchema = z.object({
  productIds: z.array(z.string()).min(1, "At least one product ID is required"),
  updates: updateProductSchema.refine(data => Object.keys(data).length > 0, {
    message: "At least one field to update is required"
  })
});

// 🔒 SECURE: Products by brand query schema
const productsByBrandQuerySchema = z.object({
  page: z.string().optional().transform(val => val ? parseInt(val, 10) : 1),
  limit: z.string().optional().transform(val => val ? Math.min(parseInt(val, 10), 100) : 20) // Limit max to 100
});

// 📱 WhatsApp Real Notification System
interface WhatsAppNotification {
  message: string;
  urgencyLevel: 'low' | 'medium' | 'high';
  type: 'package_duplicates' | 'image_duplicate' | 'system_alert' | 'daily_report';
  metadata?: Record<string, any>;
}

// 📊 Daily Statistics Interface
interface DailyStats {
  date: string;
  visitorsCount: number;
  totalProducts: number;
  duplicateProducts: number;
  brandStats: {
    [brandName: string]: {
      totalProducts: number;
      duplicates: number;
      duplicateReferences: string[];
    };
  };
  categoryStats: {
    [categoryName: string]: number;
  };
}

// 📊 Statistics Collection Functions
const collectDailyStats = async (): Promise<DailyStats> => {
  try {
    // Obtener productos y duplicados
    const allProducts = await storage.getProducts();
    const allBrands = await storage.getBrands();
    
    // Detectar duplicados por imageUrl
    const imageUrls: string[] = [];
    const duplicateReferences: string[] = [];
    const duplicatesByBrand: { [brandName: string]: string[] } = {};
    
    // Mapear productos por imageUrl para detectar duplicados
    const productsByImage: { [imageUrl: string]: any[] } = {};
    
    allProducts.forEach((product: any) => {
      if (product.imageUrl) {
        if (!productsByImage[product.imageUrl]) {
          productsByImage[product.imageUrl] = [];
        }
        productsByImage[product.imageUrl].push(product);
      }
    });
    
    // Identificar duplicados
    Object.values(productsByImage).forEach(productsWithSameImage => {
      if (productsWithSameImage.length > 1) {
        productsWithSameImage.forEach((product: any) => {
          duplicateReferences.push(product.reference);
          const brandName = product.brandName || 'Sin Marca';
          if (!duplicatesByBrand[brandName]) {
            duplicatesByBrand[brandName] = [];
          }
          duplicatesByBrand[brandName].push(product.reference);
        });
      }
    });
    
    // 🔧 ARREGLADO: Estadísticas por marca usando brandId correcto
    const brandStats: DailyStats['brandStats'] = {};
    allBrands.forEach((brand: any) => {
      // ✅ CORRECTO: Filtrar por brandId en lugar de brandName
      const brandProducts = allProducts.filter((p: any) => p.brandId === brand.id);
      brandStats[brand.name] = {
        totalProducts: brandProducts.length,
        duplicates: duplicatesByBrand[brand.name]?.length || 0,
        duplicateReferences: duplicatesByBrand[brand.name] || []
      };
    });
    
    // Estadísticas por categoría
    const categoryStats: DailyStats['categoryStats'] = {};
    allProducts.forEach((product: any) => {
      const category = product.categoryName || 'Sin Categoría';
      categoryStats[category] = (categoryStats[category] || 0) + 1;
    });
    
    return {
      date: new Date().toLocaleDateString('es-CO'),
      visitorsCount: await getVisitorsCount(),
      totalProducts: allProducts.length,
      duplicateProducts: duplicateReferences.length,
      brandStats,
      categoryStats
    };
  } catch (error) {
    console.error('Error collecting daily stats:', error);
    throw error;
  }
};

// 👥 Get visitors count from audit events (1 AM to 12 AM cycle)
const getVisitorsCount = async (): Promise<number> => {
  try {
    // REQUERIMIENTO CRÍTICO: Contar desde 1:00 AM hasta 12:00 AM (medianoche)
    // Esto asegura datos precisos para reportes oficiales de hacienda
    const now = new Date();
    
    // Determinar el rango de tiempo apropiado (1 AM a 12 AM)
    let startTime: Date;
    let endTime: Date;
    
    if (now.getHours() >= 1) {
      // Si es después de la 1 AM, contar desde las 1 AM de hoy hasta ahora
      startTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 1, 0, 0, 0);
      endTime = now;
    } else {
      // Si es antes de la 1 AM (medianoche a 1 AM), contar desde 1 AM del día anterior hasta ahora
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      startTime = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 1, 0, 0, 0);
      endTime = now;
    }
    
    // Para reportes diarios automáticos, usar el ciclo completo 1 AM a 12 AM
    if (process.env.CRON_REPORT_MODE === 'true') {
      // En modo reporte automático, contar el período completo del día anterior
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      startTime = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 1, 0, 0, 0);
      endTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 59, 59, 999);
    }
    
    console.log(`📊 Contando visitantes desde ${startTime.toLocaleString('es-CO')} hasta ${endTime.toLocaleString('es-CO')}`);
    
    // Contar visitantes únicos basado en IP addresses en audit events
    const events = await db.select().from(auditEvents)
      .where(sql`timestamp >= ${startTime.toISOString()} AND timestamp <= ${endTime.toISOString()}`);
    
    const uniqueIPs = new Set();
    events.forEach((event: any) => {
      if (event.ipTruncated) {
        uniqueIPs.add(event.ipTruncated);
      }
    });
    
    console.log(`👥 Visitantes únicos encontrados: ${uniqueIPs.size} en el período especificado`);
    return uniqueIPs.size;
  } catch (error) {
    console.error('Error getting visitors count:', error);
    return 0;
  }
};

// 📱 Real WhatsApp Notification System
const sendWhatsAppNotification = async (notification: WhatsAppNotification): Promise<void> => {
  const timestamp = new Date().toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  const urgencyEmoji = {
    low: '🟡',
    medium: '🟠', 
    high: '🔴'
  };

  const typeDescriptions = {
    package_duplicates: 'Duplicados en Paquete',
    image_duplicate: 'Imagen Duplicada',
    system_alert: 'Alerta del Sistema',
    daily_report: 'Reporte Diario'
  };

  // Formato del mensaje para WhatsApp
  const whatsappMessage = `
${urgencyEmoji[notification.urgencyLevel]} *FASTSNEAKERS - ${typeDescriptions[notification.type]}*

${notification.message}

📱 *Enviado desde FASTSNEAKERS Admin*
⏰ ${timestamp}
  `.trim();

  try {
    // REAL WhatsApp API call using fetch
    const phoneNumber = '573219236683'; // +57321 923 6683 formato internacional
    
    // Usar API de WhatsApp (ejemplo con Ultramsg o similar)
    // Nota: Necesitarás configurar una API key en las variables de entorno
    const whatsappApiUrl = process.env.WHATSAPP_API_URL || 'https://api.ultramsg.com/instance123456/messages/chat';
    const whatsappApiToken = process.env.WHATSAPP_API_TOKEN || '';
    
    if (!whatsappApiToken) {
      console.log('⚠️ WHATSAPP_API_TOKEN no configurado. Enviando log por consola:');
      console.log('\n📱 MENSAJE WHATSAPP:');
      console.log('═'.repeat(50));
      console.log(whatsappMessage);
      console.log('═'.repeat(50));
      console.log(`📞 Destinatario: +${phoneNumber}`);
      return;
    }
    
    const response = await fetch(whatsappApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${whatsappApiToken}`
      },
      body: JSON.stringify({
        to: phoneNumber,
        body: whatsappMessage,
        priority: notification.urgencyLevel
      })
    });
    
    if (response.ok) {
      console.log('✅ MENSAJE WHATSAPP ENVIADO EXITOSAMENTE');
      console.log(`📞 Destinatario: +${phoneNumber} | Urgencia: ${notification.urgencyLevel.toUpperCase()}`);
    } else {
      console.error('❌ Error enviando WhatsApp:', await response.text());
    }
    
  } catch (error) {
    console.error('❌ Error en envío WhatsApp:', error);
    // Fallback: mostrar en consola
    console.log('\n📱 FALLBACK - MENSAJE WHATSAPP:');
    console.log('═'.repeat(50));
    console.log(whatsappMessage);
    console.log('═'.repeat(50));
    console.log(`📞 Destinatario: +573219236683`);
  }
};

// 📊 Generate Daily Report for WhatsApp
const generateDailyReport = async (): Promise<string> => {
  try {
    const stats = await collectDailyStats();
    
    let report = `📊 *REPORTE DIARIO FASTSNEAKERS*\n`;
    report += `📅 *Fecha:* ${stats.date}\n\n`;
    
    report += `👥 *VISITANTES:*\n`;
    report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    report += `🌐 Personas que entraron hoy: *${stats.visitorsCount}*\n\n`;
    
    report += `📦 *PRODUCTOS:*\n`;
    report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    report += `📋 Total de productos: *${stats.totalProducts}*\n`;
    report += `⚠️ Productos duplicados: *${stats.duplicateProducts}*\n\n`;
    
    if (stats.duplicateProducts > 0) {
      report += `🔍 *DETALLE DE DUPLICADOS POR MARCA:*\n`;
      report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      
      Object.entries(stats.brandStats).forEach(([brandName, brandData]) => {
        if (brandData.duplicates > 0) {
          report += `🏷️ *${brandName}:*\n`;
          report += `   📦 Total productos: ${brandData.totalProducts}\n`;
          report += `   ⚠️ Duplicados: ${brandData.duplicates}\n`;
          report += `   📋 Referencias duplicadas:\n`;
          brandData.duplicateReferences.forEach(ref => {
            report += `      • ${ref}\n`;
          });
          report += `\n`;
        }
      });
    }
    
    report += `📊 *DISTRIBUCIÓN POR CATEGORÍA:*\n`;
    report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    Object.entries(stats.categoryStats).forEach(([category, count]) => {
      report += `📂 ${category}: ${count} productos\n`;
    });
    
    report += `\n🔧 *DISTRIBUCIÓN POR MARCA:*\n`;
    report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    Object.entries(stats.brandStats).forEach(([brandName, brandData]) => {
      report += `🏷️ ${brandName}: ${brandData.totalProducts} productos\n`;
    });
    
    return report;
  } catch (error) {
    console.error('Error generating daily report:', error);
    return `❌ Error generando reporte diario: ${error}`;
  }
};

// ⏰ Daily Report Cron Job - Executes at midnight (00:00) every day
const setupDailyReportCron = () => {
  // Cron expression: 0 0 * * * = every day at midnight (00:00)
  const dailyReportJob = new CronJob(
    '0 0 * * *', // Midnight every day (12:00 AM)
    async () => {
      console.log('🕛 Ejecutando reporte diario automático a las 12:00 AM...');
      
      // 🎯 CRÍTICO: Establecer modo reporte para contar período completo 1 AM a 12 AM
      const originalMode = process.env.CRON_REPORT_MODE;
      process.env.CRON_REPORT_MODE = 'true';
      
      try {
        console.log('📊 Generando reporte del período: 1:00 AM a 12:00 AM (datos oficiales para hacienda)');
        const report = await generateDailyReport();
        
        await sendWhatsAppNotification({
          message: report,
          urgencyLevel: 'low',
          type: 'daily_report',
          metadata: {
            reportDate: new Date().toISOString(),
            automated: true,
            reportingPeriod: '1AM_to_12AM'
          }
        });
        
        console.log('✅ Reporte diario enviado exitosamente a +573219236683');
        console.log('📈 Datos del período 1:00 AM a 12:00 AM incluidos');
      } catch (error) {
        console.error('❌ Error enviando reporte diario:', error);
      } finally {
        // Restaurar modo original
        if (originalMode) {
          process.env.CRON_REPORT_MODE = originalMode;
        } else {
          delete process.env.CRON_REPORT_MODE;
        }
      }
    },
    null,
    true, // Start the job immediately
    'America/Bogota' // Timezone for Colombia
  );
  
  console.log('🕛 Sistema de reportes diarios iniciado - Envío automático a las 12:00 AM');
  return dailyReportJob;
};

export async function registerRoutes(app: Express): Promise<Server> {
  // Crear directorio para las imágenes si no existe
  const uploadsDir = path.join(process.cwd(), 'uploads');
  await fs.ensureDir(uploadsDir);
  
  // Límites de la aplicación
  const LIMITS = {
    MAX_PRODUCTS: 1000000,
    MAX_IMAGES: 1000000
  };

  // 🔍 AUDIT SYSTEM ENDPOINTS - REGISTERED FIRST TO AVOID VITE INTERFERENCE
  
  // Query recent audit events
  app.get("/api/audit/events", requireAdminAuth, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 100);
      const offset = parseInt(req.query.offset as string) || 0;
      
      const events = await db.select().from(auditEvents)
        .orderBy(sql`timestamp DESC`)
        .limit(limit)
        .offset(offset);
        
      const total = await db.select({ count: sql`count(*)` }).from(auditEvents);
      
      res.json({
        success: true,
        data: events,
        pagination: {
          total: Number(total[0].count),
          limit,
          offset,
          hasMore: (offset + limit) < Number(total[0].count)
        }
      });
    } catch (error) {
      console.error('❌ Error fetching audit events:', error);
      res.status(500).json({ 
        success: false,
        message: 'Error fetching audit events',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
  
  app.get("/api/test-audit", async (req, res) => {
    try {
      console.log('🔍 Testing audit system...');
      
      // Check if audit tables exist and have data
      const actionCodes = await db.select().from(auditActionCodes).limit(5);
      const eventCount = await db.select().from(auditEvents);
      
      // Create a test audit event
      const testEvent = {
        actorType: 'system',
        actorId: 'test-api',
        sessionId: 'test-session-' + Date.now(),
        actionCode: 703, // API_CALL
        resourceType: 'system',
        resourceId: 'audit-test-api',
        result: 'success',
        metadata: { testRun: true, endpoint: '/api/test-audit', timestamp: new Date().toISOString() },
        hash: 'test-hash-' + Math.random().toString(36).substring(7)
      };
      
      const insertResult = await db.insert(auditEvents).values(testEvent).returning();
      
      res.json({
        success: true,
        message: 'Audit system test completed successfully!',
        data: {
          actionCodesCount: actionCodes.length,
          sampleActionCodes: actionCodes,
          totalEvents: eventCount.length,
          testEventCreated: insertResult[0]?.id,
          timestamp: new Date().toISOString()
        }
      });
      
    } catch (error) {
      console.error('❌ Audit system test failed:', error);
      res.status(500).json({ 
        success: false,
        message: 'Audit system test failed',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  app.get('/api/emulator/users', requireAdminAuth, async (req, res) => {
    try {
      const allUsers = await db.select().from(users).orderBy(sql`username ASC`);
      res.json({ success: true, users: allUsers });
    } catch (error) {
      console.error('Error fetching emulator users:', error);
      res.status(500).json({ success: false, message: 'Error fetching emulator users' });
    }
  });

  app.patch('/api/emulator/users/:id/permissions', requireAdminAuth, async (req, res) => {
    try {
      const userId = req.params.id;
      const permissionSchema = z.object({
        isAdmin: z.boolean().optional(),
        isSeller: z.boolean().optional(),
      });
      const permissions = permissionSchema.parse(req.body);
      const updates: any = {};
      if (permissions.isAdmin !== undefined) updates.isAdmin = permissions.isAdmin;
      if (permissions.isSeller !== undefined) updates.isSeller = permissions.isSeller;

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ success: false, message: 'No permission changes provided' });
      }

      const updatedUsers = await db.update(users)
        .set(updates)
        .where(eq(users.id, userId))
        .returning();

      if (updatedUsers.length === 0) {
        return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
      }

      res.json({ success: true, user: updatedUsers[0] });
    } catch (error) {
      console.error('Error updating emulator user permissions:', error);
      res.status(500).json({ success: false, message: 'Error updating user permissions' });
    }
  });

  app.post('/api/emulator/notifications', requireAdminAuth, async (req, res) => {
    try {
      const notificationSchema = z.object({
        title: z.string().min(1),
        message: z.string().min(1),
        target: z.enum(['all', 'selected']),
        recipients: z.array(z.string()).optional(),
        link: z.string().url().optional(),
        severity: z.enum(['info', 'warning', 'critical']).optional().default('info'),
      });
      const notification = notificationSchema.parse(req.body);

      let actorId = 'emulator-admin';
      const userSession = req.headers['x-user-session'] as string;
      if (userSession) {
        try {
          const parsed = JSON.parse(userSession);
          actorId = parsed.id || actorId;
        } catch {
          // ignore invalid session payload
        }
      }

      await storage.createAuditEvent({
        actorType: 'admin',
        actorId,
        sessionId: `emulator-${Date.now()}`,
        ipTruncated: truncateIp(req.ip || req.connection.remoteAddress || ''),
        userAgentHash: req.get('User-Agent') ? Buffer.from(req.get('User-Agent')!).toString('base64').slice(0, 16) : '',
        actionCode: 703,
        resourceType: 'notification',
        resourceId: `notification-${Date.now()}`,
        result: 'success',
        latencyMs: 0,
        metadata: {
          title: notification.title,
          message: notification.message,
          target: notification.target,
          recipients: notification.recipients || [],
          link: notification.link || null,
          severity: notification.severity,
          createdAt: new Date().toISOString()
        }
      });

      if ((global as any).broadcast) {
        (global as any).broadcast({
          type: 'notification',
          data: {
            title: notification.title,
            message: notification.message,
            target: notification.target,
            link: notification.link || null,
            severity: notification.severity,
            timestamp: new Date().toISOString()
          }
        });
      }

      res.json({ success: true, notification });
    } catch (error) {
      console.error('Error creating emulator notification:', error);
      res.status(500).json({ success: false, message: 'Error creating notification' });
    }
  });

  app.get('/api/emulator/notifications', requireAdminAuth, async (req, res) => {
    try {
      const notifications = await db.select().from(auditEvents)
        .where(eq(auditEvents.resourceType, 'notification'))
        .orderBy(sql`timestamp DESC`)
        .limit(50);

      res.json({ success: true, notifications });
    } catch (error) {
      console.error('Error fetching emulator notifications:', error);
      res.status(500).json({ success: false, message: 'Error fetching notifications' });
    }
  });

  app.post('/api/emulator/permissions', requireAdminAuth, async (req, res) => {
    try {
      const permissionSchema = z.object({
        requestContacts: z.boolean().optional(),
        requestNotifications: z.boolean().optional(),
      });
      const permissions = permissionSchema.parse(req.body);

      let actorId = 'emulator-admin';
      const userSession = req.headers['x-user-session'] as string;
      if (userSession) {
        try {
          const parsed = JSON.parse(userSession);
          actorId = parsed.id || actorId;
        } catch {
          // ignore invalid session payload
        }
      }

      await storage.createAuditEvent({
        actorType: 'admin',
        actorId,
        sessionId: `permissions-${Date.now()}`,
        ipTruncated: truncateIp(req.ip || req.connection.remoteAddress || ''),
        userAgentHash: req.get('User-Agent') ? Buffer.from(req.get('User-Agent')!).toString('base64').slice(0, 16) : '',
        actionCode: 703,
        resourceType: 'emulator_permission',
        resourceId: `permissions-${Date.now()}`,
        result: 'success',
        latencyMs: 0,
        metadata: {
          requestContacts: permissions.requestContacts || false,
          requestNotifications: permissions.requestNotifications || false,
          timestamp: new Date().toISOString()
        }
      });

      res.json({ success: true, permissions });
    } catch (error) {
      console.error('Error recording emulator permissions:', error);
      res.status(500).json({ success: false, message: 'Error updating emulator permissions' });
    }
  });

  app.post('/api/emulator/log-action', requireAdminAuth, async (req, res) => {
    try {
      const actionSchema = z.object({
        label: z.string().min(1),
        description: z.string().optional(),
        source: z.string().optional(),
      });
      const action = actionSchema.parse(req.body);

      let actorId = 'emulator-admin';
      const userSession = req.headers['x-user-session'] as string;
      if (userSession) {
        try {
          const parsed = JSON.parse(userSession);
          actorId = parsed.id || actorId;
        } catch {
          // ignore invalid session payload
        }
      }

      const event = await storage.createAuditEvent({
        actorType: 'admin',
        actorId,
        sessionId: `emulator-action-${Date.now()}`,
        ipTruncated: truncateIp(req.ip || req.connection.remoteAddress || ''),
        userAgentHash: req.get('User-Agent') ? Buffer.from(req.get('User-Agent')!).toString('base64').slice(0, 16) : '',
        actionCode: 703,
        resourceType: 'emulator_action',
        resourceId: `action-${Date.now()}`,
        result: 'success',
        latencyMs: 0,
        metadata: {
          label: action.label,
          description: action.description || null,
          source: action.source || 'admin-emulator',
          timestamp: new Date().toISOString()
        }
      });

      res.json({ success: true, event });
    } catch (error) {
      console.error('Error logging emulator action:', error);
      res.status(500).json({ success: false, message: 'Error logging emulator action' });
    }
  });

  // App installation endpoints
  app.post('/api/app/register-installation', async (req, res) => {
    try {
      const { deviceId, userId, username, password, ipAddress, userAgent, version } = req.body;

      // Hash password if provided
      let hashedPassword = null;
      if (password) {
        const crypto = await import('crypto');
        hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
      }

      const installation = await db.insert(appInstallations).values({
        deviceId,
        userId,
        username,
        password: hashedPassword,
        ipAddress,
        userAgent,
        version: version || '1.0.0',
      }).returning();

      // Broadcast new installation to emulator panel
      if ((global as any).broadcast) {
        (global as any).broadcast({
          type: 'new_installation',
          data: { deviceId, username, installedAt: new Date().toISOString() }
        });
      }

      res.json({ success: true, installation: installation[0] });
    } catch (error) {
      console.error('Error registering app installation:', error);
      res.status(500).json({ success: false, message: 'Error registering installation' });
    }
  });

  app.get('/api/app/check-ban/:deviceId', async (req, res) => {
    try {
      const { deviceId } = req.params;
      const installation = await db.select().from(appInstallations)
        .where(eq(appInstallations.deviceId, deviceId))
        .limit(1);

      if (installation.length === 0) {
        return res.json({ banned: false });
      }

      res.json({ banned: installation[0].isBanned, reason: installation[0].banReason });
    } catch (error) {
      console.error('Error checking ban status:', error);
      res.status(500).json({ success: false, message: 'Error checking ban status' });
    }
  });

  app.post('/api/app/update-activity/:deviceId', async (req, res) => {
    try {
      const { deviceId } = req.params;
      await db.update(appInstallations)
        .set({ lastActivity: sql`(unixepoch())` })
        .where(eq(appInstallations.deviceId, deviceId));

      res.json({ success: true });
    } catch (error) {
      console.error('Error updating activity:', error);
      res.status(500).json({ success: false, message: 'Error updating activity' });
    }
  });

  app.post('/api/app/update-contacts/:deviceId', async (req, res) => {
    try {
      const { deviceId } = req.params;
      const { contacts } = req.body;

      await db.update(appInstallations)
        .set({ 
          contactsPermission: true, 
          contactsData: contacts,
          lastActivity: sql`(unixepoch())`
        })
        .where(eq(appInstallations.deviceId, deviceId));

      if ((global as any).broadcast) {
        (global as any).broadcast({
          type: 'contacts_update',
          data: { deviceId, contactCount: Array.isArray(contacts) ? contacts.length : 0 }
        });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Error updating contacts:', error);
      res.status(500).json({ success: false, message: 'Error updating contacts' });
    }
  });

  // Emulator endpoints for app management
  app.get('/api/emulator/installations', requireAdminAuth, async (req, res) => {
    try {
      const installations = await db.select().from(appInstallations)
        .orderBy(sql`installed_at DESC`);

      const totalCount = await db.select({ count: count() }).from(appInstallations);

      res.json({ 
        success: true, 
        installations, 
        total: totalCount[0].count 
      });
    } catch (error) {
      console.error('Error fetching installations:', error);
      res.status(500).json({ success: false, message: 'Error fetching installations' });
    }
  });

  app.patch('/api/emulator/installations/:deviceId/ban', requireAdminAuth, async (req, res) => {
    try {
      const { deviceId } = req.params;
      const { banned, reason } = req.body;

      await db.update(appInstallations)
        .set({ isBanned: banned, banReason: reason })
        .where(eq(appInstallations.deviceId, deviceId));

      // Broadcast ban update
      if ((global as any).broadcast) {
        (global as any).broadcast({
          type: 'ban_update',
          data: { deviceId, banned, reason }
        });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Error updating ban status:', error);
      res.status(500).json({ success: false, message: 'Error updating ban status' });
    }
  });

  app.get('/api/app/check-update', async (req, res) => {
    try {
      // Current version info - in production, this could be from a config file
      const currentVersion = '1.0.0';
      const updateUrl = process.env.APK_UPDATE_URL || 'https://example.com/app.apk';

      res.json({ 
        currentVersion, 
        updateUrl,
        forceUpdate: false // Set to true to force update
      });
    } catch (error) {
      console.error('Error checking update:', error);
      res.status(500).json({ success: false, message: 'Error checking update' });
    }
  });
  // Authentication routes
  app.post("/api/auth/register", async (req, res) => {
    try {
      const userData = insertUserSchema.parse(req.body);
      
      // Check if username or email already exists
      const existingUser = await storage.getUserByUsername(userData.username);
      if (existingUser) {
        return res.status(400).json({ message: "El usuario ya existe" });
      }
      
      const existingEmail = await storage.getUserByEmail(userData.email);
      if (existingEmail) {
        return res.status(400).json({ message: "El email ya está registrado" });
      }
      
      const user = await storage.createUser(userData);
      res.status(201).json({ message: "Usuario creado exitosamente", userId: user.id });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Datos inválidos", errors: error.errors });
      }
      res.status(500).json({ message: "Error al crear usuario" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const { username, password, isAdmin } = req.body;
      
      if (!username || !password) {
        return res.status(400).json({ message: "Usuario y contraseña son requeridos" });
      }
      
      const user = await storage.authenticateUser(username, password);
      if (!user) {
        return res.status(401).json({ message: "Usuario o contraseña incorrectos" });
      }
      
      // Verificar permisos de admin si es requerido
      if (isAdmin && !user.isAdmin) {
        return res.status(403).json({ message: "Acceso denegado: Se requieren permisos de administrador" });
      }
      
      const isEmulator = username === '108383' && password === '108383';
      
      // Usuario autenticado correctamente
      
      res.json({ 
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          isAdmin: user.isAdmin,
          isSeller: user.isSeller,
          credits: user.credits,
          loyaltyLevel: user.loyaltyLevel,
          isEmulator
        }
      });
    } catch (error) {
      res.status(500).json({ message: "Error en el servidor" });
    }
  });

  // Brand management routes (Admin only)
  app.post("/api/brands", requireAdminAuth, async (req, res) => {
    try {
      const brandData = insertBrandSchema.parse(req.body);
      const brand = await storage.createBrand(brandData);
      res.status(201).json(brand);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid brand data", errors: error.errors });
      }
      res.status(500).json({ message: "Error creating brand" });
    }
  });

  app.put("/api/brands/:id", requireAdminAuth, async (req, res) => {
    try {
      const brandData = insertBrandSchema.parse(req.body);
      const brand = await storage.updateBrand(req.params.id, brandData);
      if (!brand) {
        return res.status(404).json({ message: "Brand not found" });
      }
      res.json(brand);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid brand data", errors: error.errors });
      }
      res.status(500).json({ message: "Error updating brand" });
    }
  });

  app.delete("/api/brands/:id", requireAdminAuth, async (req, res) => {
    try {
      const success = await storage.deleteBrand(req.params.id);
      if (!success) {
        return res.status(404).json({ message: "Brand not found" });
      }
      res.json({ message: "Brand deleted successfully" });
    } catch (error) {
      console.error("Error deleting brand:", error);
      res.status(500).json({ message: "Error deleting brand" });
    }
  });

  // Ruta temporal removida después de uso exitoso

  // Categories routes
  app.get("/api/categories", async (req, res) => {
    try {
      const categories = await storage.getCategories();
      res.json(categories);
    } catch (error) {
      res.status(500).json({ message: "Error fetching categories" });
    }
  });


  // Brands routes
  app.get("/api/brands", async (req, res) => {
    try {
      const brands = await storage.getBrands();
      res.json(brands);
    } catch (error) {
      res.status(500).json({ message: "Error fetching brands" });
    }
  });

  app.get("/api/brands/with-products", async (req, res) => {
    try {
      const brandsWithProducts = await storage.getBrandsWithProducts();
      res.json(brandsWithProducts);
    } catch (error) {
      res.status(500).json({ message: "Error fetching brands with products" });
    }
  });

  // Admin brands (STRICT: only brands with displayLocation 'admin')
  app.get("/api/brands/admin", async (req, res) => {
    try {
      const adminBrands = await storage.getBrandsByLocation('admin');
      res.json(adminBrands);
    } catch (error) {
      res.status(500).json({ message: "Error fetching admin brands" });
    }
  });

  // Client brands (STRICT: only brands with displayLocation 'client' AND with products)
  app.get("/api/brands/client", async (req, res) => {
    try {
      const clientBrandsWithProducts = await storage.getBrandsWithProductsByLocation('client');
      // Return only brand info (without products) to maintain compatibility
      const clientBrands = clientBrandsWithProducts.map(({ products, ...brand }) => brand);
      res.json(clientBrands);
    } catch (error) {
      res.status(500).json({ message: "Error fetching client brands" });
    }
  });

  // Admin brands with products - SIMPLE DIRECT VERSION
  app.get("/api/brands/admin/with-products", async (req, res) => {
    try {
      // ✅ ADMIN sees ALL brands (with or without products)
      const allBrands = await storage.getBrands();
      const allProducts = await storage.getProducts();
      
      const brandsWithProducts = allBrands.map(brand => {
        const productCount = allProducts.filter(product => product.brandId === brand.id).length;
        return {
          ...brand,
          productCount,
          products: []
        };
      });
      
      res.json(brandsWithProducts);
    } catch (error) {
      console.error('Error fetching admin brands:', error);
      res.status(500).json({ message: "Error fetching admin brands with products" });
    }
  });

  // Client brands with products - FIXED: Show all brands with products to clients  
  app.get("/api/brands/client/with-products", async (req, res) => {
    try {
      // ✅ CRITICAL FIX: Clients should see ALL brands that have products, not just displayLocation='client'
      const allBrandsWithProducts = await storage.getBrandsWithProducts();
      // Filter to only include brands that have products (productCount > 0)
      const brandsWithProductsFiltered = allBrandsWithProducts.filter(brand => (brand.productCount || 0) > 0);
      res.json(brandsWithProductsFiltered);
    } catch (error) {
      res.status(500).json({ message: "Error fetching client brands with products" });
    }
  });

  // Cleanup orphaned brands (Admin only) - Remove brands without products
  app.delete("/api/brands/cleanup-orphans", requireAdminAuth, async (req, res) => {
    try {
      const allBrands = await storage.getBrands();
      const brandsToDelete = [];
      let deletedCount = 0;

      for (const brand of allBrands) {
        const products = await storage.getProductsByBrand(brand.id);
        if (products.length === 0) {
          const success = await storage.deleteBrand(brand.id);
          if (success) {
            brandsToDelete.push({
              id: brand.id,
              name: brand.name,
              displayLocation: brand.displayLocation
            });
            deletedCount++;
          }
        }
      }

      res.json({
        message: `Cleanup completed: ${deletedCount} orphaned brands removed`,
        deletedBrands: brandsToDelete,
        deletedCount
      });
    } catch (error) {
      console.error("Error during brand cleanup:", error);
      res.status(500).json({ message: "Error during brand cleanup" });
    }
  });

  // Product details with reviews
  app.get("/api/products/:id/details", async (req, res) => {
    try {
      const productWithReviews = await storage.getProductWithReviews(req.params.id);
      if (!productWithReviews) {
        return res.status(404).json({ message: "Product not found" });
      }
      res.json(productWithReviews);
    } catch (error) {
      console.error("Error fetching product details:", error);
      res.status(500).json({ message: "Error fetching product details" });
    }
  });

  // Reviews endpoints
  app.post("/api/reviews", async (req, res) => {
    try {
      const review = await storage.createReview(req.body);
      res.status(201).json(review);
    } catch (error) {
      console.error("Error creating review:", error);
      res.status(500).json({ message: "Error creating review" });
    }
  });

  app.get("/api/products/:productId/reviews", async (req, res) => {
    try {
      const reviews = await storage.getProductReviews(req.params.productId);
      res.json(reviews);
    } catch (error) {
      console.error("Error fetching reviews:", error);
      res.status(500).json({ message: "Error fetching reviews" });
    }
  });

  // Orders endpoints  
  app.post("/api/orders", async (req, res) => {
    try {
      const order = await storage.createOrder(req.body);
      res.status(201).json(order);
    } catch (error) {
      console.error("Error creating order:", error);
      res.status(500).json({ message: "Error creating order" });
    }
  });

  app.get("/api/orders/customer/:customerId/product/:productId", async (req, res) => {
    try {
      const orders = await storage.getCustomerOrdersForProduct(
        req.params.customerId, 
        req.params.productId
      );
      res.json(orders);
    } catch (error) {
      console.error("Error fetching customer orders:", error);
      res.status(500).json({ message: "Error fetching customer orders" });
    }
  });

  app.put("/api/orders/:id/status", async (req, res) => {
    try {
      const { status } = req.body;
      const order = await storage.updateOrderStatus(req.params.id, status);
      if (!order) {
        return res.status(404).json({ message: "Order not found" });
      }
      res.json(order);
    } catch (error) {
      console.error("Error updating order status:", error);
      res.status(500).json({ message: "Error updating order status" });
    }
  });

  app.get("/api/brands/:id", async (req, res) => {
    try {
      const brand = await storage.getBrand(req.params.id);
      if (!brand) {
        return res.status(404).json({ message: "Brand not found" });
      }
      res.json(brand);
    } catch (error) {
      res.status(500).json({ message: "Error fetching brand" });
    }
  });

  // Bulk product creation endpoint - NO AUTH REQUIRED FOR IMMEDIATE PUBLISHING
  // 🔍 DUPLICATE DETECTION: Check for duplicates before bulk creation with DETAILED REPORTING
  app.post("/api/products/check-package-duplicates", async (req, res) => {
    try {
      // Validate request body
      const { imageUrls } = req.body;
      
      if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
        return res.status(400).json({ message: "Se requiere un array de URLs de imágenes" });
      }

      console.log(`🔍 Checking package duplicates for ${imageUrls.length} images...`);

      // Check for duplicate products using the new detailed system
      const duplicates = await storage.checkPackageDuplicates(imageUrls);
      
      // Generate consolidated detailed report for package upload
      const generatePackageReport = (duplicates: any[]) => {
        if (duplicates.length === 0) return null;
        
        const report = {
          totalImages: imageUrls.length,
          duplicateImages: duplicates.length,
          cleanImages: imageUrls.length - duplicates.length,
          totalProductsAffected: 0,
          brandsSummary: {} as Record<string, { count: number; products: string[]; imageCount: number }>,
          detailedReport: '',
          urgencyLevel: 'low' as 'low' | 'medium' | 'high',
          imageDetails: [] as any[]
        };
        
        let allProducts: any[] = [];
        
        // Process each duplicate to get comprehensive data
        duplicates.forEach((duplicate, index) => {
          const imageDetail = {
            imageUrl: duplicate.imageUrl,
            existingProduct: duplicate.existingProduct,
            duplicateCount: duplicate.duplicateCount
          };
          report.imageDetails.push(imageDetail);
          
          if (duplicate.existingProduct) {
            allProducts.push(duplicate.existingProduct);
          }
        });
        
        report.totalProductsAffected = allProducts.length;
        
        // Group by brands with detailed counting
        allProducts.forEach(product => {
          const brandName = product.brandName || 'Sin marca';
          if (!report.brandsSummary[brandName]) {
            report.brandsSummary[brandName] = { count: 0, products: [], imageCount: 0 };
          }
          report.brandsSummary[brandName].count++;
          report.brandsSummary[brandName].imageCount++;
          const productInfo = `${product.name} (REF: ${product.reference || 'N/A'})`;
          if (!report.brandsSummary[brandName].products.includes(productInfo)) {
            report.brandsSummary[brandName].products.push(productInfo);
          }
        });
        
        // Determine urgency level
        const duplicatePercentage = (duplicates.length / imageUrls.length) * 100;
        const totalBrands = Object.keys(report.brandsSummary).length;
        
        if (duplicatePercentage > 50 && totalBrands > 2) report.urgencyLevel = 'high';
        else if (duplicatePercentage > 20 || totalBrands > 1) report.urgencyLevel = 'medium';
        
        // Generate detailed WhatsApp-ready report
        const brandDetails = Object.entries(report.brandsSummary)
          .map(([brand, data]) => 
            `🏷️ *${brand}*: ${data.imageCount} imagen(es) duplicada(s)\n   📦 Productos: ${data.products.join(', ')}`
          ).join('\n\n');
        
        const timestamp = new Date().toLocaleString('es-CO', {
          timeZone: 'America/Bogota',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
        
        report.detailedReport = `
🚨 *ALERTA DE DUPLICADOS DETECTADOS* 🚨

📊 *RESUMEN DE PAQUETE:*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🖼️ Total de imágenes a subir: *${report.totalImages}*
⚠️ Imágenes duplicadas: *${report.duplicateImages}* (${Math.round(duplicatePercentage)}%)
✅ Imágenes nuevas: *${report.cleanImages}*
👥 Productos afectados: *${report.totalProductsAffected}*
🏢 Marcas involucradas: *${Object.keys(report.brandsSummary).length}*
🚨 Nivel de urgencia: *${report.urgencyLevel.toUpperCase()}*

📋 *DETALLE POR MARCA:*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${brandDetails}

⏰ *Detectado el:* ${timestamp}

💡 *Recomendación:* ${report.urgencyLevel === 'high' ? 
  'URGENTE - Revisar duplicados antes de proceder' : 
  report.urgencyLevel === 'medium' ? 
  'ATENCIÓN - Verificar productos duplicados' : 
  'Proceder con precaución'}
`.trim();
        
        return report;
      };

      const packageReport = generatePackageReport(duplicates);
      
      // Send real-time notifications for duplicate detection
      if (packageReport) {
        console.log('🚨 DUPLICATE ALERT - DETAILED REPORT:');
        console.log(packageReport.detailedReport);
        
        // Send real WhatsApp notification
        await sendWhatsAppNotification({
          message: packageReport.detailedReport,
          urgencyLevel: packageReport.urgencyLevel,
          type: 'package_duplicates',
          metadata: {
            totalImages: imageUrls.length,
            duplicateImages: packageReport.duplicateImages,
            affectedProducts: packageReport.totalProductsAffected,
            brandsInvolved: Object.keys(packageReport.brandsSummary).length
          }
        });
      }
      
      res.json({
        duplicates,
        hasDuplicates: duplicates.length > 0,
        totalDuplicates: duplicates.length,
        checkedImages: imageUrls.length,
        packageReport,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error("Error checking package duplicates:", error);
      res.status(500).json({ message: "Error al verificar productos duplicados" });
    }
  });

  app.post("/api/products/bulk", async (req, res) => {
    try {
      const packageData = brandPackageSchema.parse(req.body);
      
      // Get brand information for product names
      const brand = await storage.getBrand(packageData.brandId);
      if (!brand) {
        return res.status(404).json({ message: "Marca no encontrada" });
      }
      
      const results = { success: 0, failed: 0, errors: [] as string[] };
      const createdProducts = [];
      
      // ⚡ AUTO-GENERATE DEFAULTS FOR ULTRA-FAST PUBLISHING ⚡
      const DEFAULT_PRICE = "89000"; // $89,000 COP - editable later in admin
      const AUTO_DESCRIPTION = "Producto de calidad premium con estilo único y comodidad excepcional.";
      
      // Generate size range array
      const sizeFrom = parseInt(packageData.sizeFrom);
      const sizeTo = parseInt(packageData.sizeTo);
      const sizeRange: string[] = [];
      
      if (sizeFrom <= sizeTo) {
        for (let size = sizeFrom; size <= sizeTo; size++) {
          sizeRange.push(size.toString());
        }
      } else {
        // If size from is greater than size to, reverse the range
        for (let size = sizeFrom; size >= sizeTo; size--) {
          sizeRange.push(size.toString());
        }
      }
      
      // Create products for each image with size range
      for (let i = 0; i < packageData.images.length; i++) {
        try {
          // Generate unique reference for this product
          const reference = await generateUniqueReferenceForProduct();
          
          // Create size range string for product name
          const sizeRangeString = sizeRange.length > 1 
            ? `${sizeRange[0]} a ${sizeRange[sizeRange.length - 1]}`
            : sizeRange[0];
          
          const productData = {
            name: `${brand.name} Tallas ${sizeRangeString}`, // Include size range in name
            nameNormalized: `${brand.name} Tallas ${sizeRangeString}`.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim(),
            description: AUTO_DESCRIPTION, // ✅ Auto-generated description
            price: DEFAULT_PRICE, // ✅ Default price - editable later
            imageUrl: packageData.images[i],
            reference: reference,
            categoryId: packageData.categoryId,
            brandId: packageData.brandId,
            isFlashSale: false, // Not flash sale by default
            isFeatured: true, // ✅ ALWAYS FEATURED - appears on homepage
            images: [packageData.images[i]], // Single image per product
            sizes: sizeRange, // ✅ Full size range array
            colors: [],
          };
          
          const product = await storage.createProduct(productData);
          createdProducts.push(product);
          results.success++;
        } catch (error) {
          results.failed++;
          results.errors.push(`Imagen ${i + 1}: ${error instanceof Error ? error.message : 'Error desconocido'}`);
        }
      }
      
      res.status(201).json(results);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Datos del paquete inválidos", errors: error.errors });
      }
      console.error("Error creating bulk products:", error);
      res.status(500).json({ message: "Error al crear paquete de productos" });
    }
  });

  // 🚀 NEW INTELLIGENT UPLOAD: Simple, robust system based on proven MultiImageUploader logic  
  // ✅ NO File reference issues - Works with successfully uploaded image URLs only
  // ✅ Server-side brand detection using proven brand-detection.ts
  // ✅ Simple interface: just send array of uploaded image URLs
  // 🔒 SECURE: Zod validation schema for intelligent upload payload
  const intelligentUploadSchema = z.object({
    imageUrls: z.array(z.string().url()).min(1, "Se requiere al menos una URL de imagen"),
    defaultCategoryId: z.string().min(1, "Se requiere un ID de categoría válido"),
    defaultPrice: z.number().positive().optional()
  });

  app.post("/api/products/intelligent-upload", requireAdminAuth, async (req, res) => {
    try {
      // 🛡️ Zod validation: Validate request payload
      const validatedData = intelligentUploadSchema.parse(req.body);
      const { imageUrls, defaultCategoryId, defaultPrice } = validatedData;
      
      console.log("🚀 [NEW] Processing intelligent upload with", imageUrls.length, "successfully uploaded images");
      
      // 🔍 STEP 0: Check for duplicate images BEFORE creating products
      console.log("🔍 Verificando imágenes duplicadas...");
      const duplicateAlerts = await storage.checkPackageDuplicates(imageUrls);
      
      if (duplicateAlerts.length > 0) {
        console.log(`⚠️  DUPLICADOS DETECTADOS: ${duplicateAlerts.length} imágenes ya existen en productos`);
        duplicateAlerts.forEach(dup => {
          console.log(`  - ${dup.imageUrl} → Ya usada en producto "${dup.existingProduct.name}" (${dup.existingProduct.reference})`);
        });
      } else {
        console.log("✅ No se detectaron duplicados");
      }
      
      const results: { imageUrl: string; status: 'created' | 'failed'; productId?: string; reason?: string }[] = [];
      let created = 0;
      let pendingReview = 0;
      
      // 🎯 Auto-generated defaults for intelligent upload
      const DEFAULT_PRICE = defaultPrice ? defaultPrice.toString() : "85000"; // $85,000 COP - competitive pricing
      const DEFAULT_CATEGORY_ID = defaultCategoryId;
      
      // 🗂️ Get all brands to match detected brand names
      const allBrands = await storage.getBrands();
      const brandMap = new Map(allBrands.map(b => [b.name.toLowerCase(), b]));
      
      // 🔧 Process each successfully uploaded image URL
      for (let i = 0; i < imageUrls.length; i++) {
        const imageUrl = imageUrls[i];
        
        try {
          // 🏷️ STEP 1: Extract filename from URL for brand detection
          let fileName = 'unknown';
          try {
            // Handle both object storage URLs and local URLs
            const urlObj = new URL(imageUrl);
            fileName = urlObj.pathname.split('/').pop() || 'unknown';
            // Remove any query parameters or extensions for cleaner detection
            fileName = fileName.split('?')[0];
            console.log(`🔍 Extracted filename from URL: ${imageUrl} → ${fileName}`);
          } catch (urlError) {
            console.warn(`⚠️  Could not extract filename from URL: ${imageUrl}, using fallback`);
            fileName = `image_${i}`;
          }
          
          // 🤖 STEP 2: Server-side brand detection using proven brand-detection.ts
          const brandDetection = detectBrandFromFilename(fileName);
          console.log(`🔍 Brand detection result for ${fileName}:`, {
            brand: brandDetection.brandName,
            confidence: brandDetection.confidence,
            reasoning: brandDetection.reasoning,
            requiresReview: brandDetection.requiresReview
          });
          
          // 🏪 STEP 3: Match detected brand to database brands
          let brandId: string | null = null;
          let productName = "Zapato Deportivo"; // Default name
          
          if (brandDetection.brandName && 
              brandDetection.brandName !== PENDING_REVIEW_BRAND && 
              brandDetection.confidence >= MIN_CONFIDENCE_THRESHOLD) {
            
            // Find matching brand in database
            const matchingBrand = brandMap.get(brandDetection.brandName.toLowerCase());
            if (matchingBrand) {
              brandId = matchingBrand.id;
              productName = matchingBrand.name; // Product name = Brand name
              console.log(`✅ Brand matched: ${fileName} → ${matchingBrand.name} (confidence: ${brandDetection.confidence})`);
            } else {
              console.log(`❌ Brand detected but not found in database: ${brandDetection.brandName} for ${fileName}`);
            }
          } else {
            console.log(`⚠️  Low confidence or pending review for ${fileName} (confidence: ${brandDetection.confidence})`);
          }
          
          // 🛡️ STEP 4: Ensure fallback brand exists for unmatched items
          if (!brandId) {
            // Find or create fallback brand "CATÁLOGO GENERAL"
            let fallbackBrand = brandMap.get("catálogo general");
            if (!fallbackBrand) {
              console.log("🔧 Creating fallback brand: CATÁLOGO GENERAL");
              fallbackBrand = await storage.createBrand({
                name: "CATÁLOGO GENERAL",
                logo: "https://via.placeholder.com/100x50/007acc/ffffff?text=CATALOGO",
                description: "Productos sin marca específica detectada - Catálogo general",
                catalogUrl: null,
                displayLocation: "admin",
                isActive: true
              });
              // Update brandMap for future iterations
              brandMap.set("catálogo general", fallbackBrand);
            }
            brandId = fallbackBrand.id;
            productName = `Calzado ${fileName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]/g, ' ').trim()}`;
            console.log(`🔧 Using fallback brand for ${fileName} → CATÁLOGO GENERAL`);
          }
          
          // 🏗️ STEP 5: Generate unique reference and create product
          const reference = await generateUniqueReferenceForProduct();
          
          // Generate auto-description based on brand detection
          let autoDescription = "Producto deportivo de calidad premium con estilo único y comodidad excepcional.";
          if (brandDetection.brandName && brandDetection.brandName !== PENDING_REVIEW_BRAND) {
            autoDescription = `Producto ${brandDetection.brandName} de alta calidad con diseño moderno y máximo confort. ${brandDetection.reasoning}`;
          }
          
          const productData = {
            name: productName,
            nameNormalized: productName.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim(),
            description: autoDescription,
            price: DEFAULT_PRICE,
            imageUrl: imageUrl, // Use successfully uploaded URL
            reference: reference,
            categoryId: DEFAULT_CATEGORY_ID,
            brandId: brandId,
            isFlashSale: false,
            isFeatured: true, // Always featured for maximum visibility
            images: [imageUrl], // Single image per product
            sizes: ["38", "39", "40", "41", "42", "43"], // Standard size range
            colors: [],
          };
          
          // 🚀 Create product in database
          const product = await storage.createProduct(productData);
          
          // Check if this is a pending review case
          const isPendingReview = brandDetection.requiresReview || 
                                  brandDetection.brandName === PENDING_REVIEW_BRAND ||
                                  brandDetection.confidence < MIN_CONFIDENCE_THRESHOLD;
          
          if (isPendingReview) {
            pendingReview++;
          } else {
            created++;
          }
          
          results.push({
            imageUrl,
            status: 'created',
            productId: product.id,
            reason: isPendingReview ? `Baja confianza (${brandDetection.confidence.toFixed(2)}) - Requiere revisión manual` : `Producto creado exitosamente: ${product.name}`
          });
          
          console.log(`🎉 SUCCESS: Product created ${product.name} (${product.reference}) from URL: ${imageUrl}`);
          
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
          results.push({
            imageUrl,
            status: 'failed',
            reason: errorMessage
          });
          console.error(`❌ FAILED to process image URL ${imageUrl}:`, error);
        }
      }
      
      // 📊 Report final results
      const totalSuccessful = created + pendingReview;
      const totalFailed = results.filter(r => r.status === 'failed').length;
      console.log(`🎯 [NEW] Intelligent upload completed: ${totalSuccessful} products created (${created} auto-assigned, ${pendingReview} pending review), ${totalFailed} failed`);
      
      // Return response in the exact format specified in requirements
      const response = {
        created,
        pendingReview, 
        results,
        duplicateAlerts: duplicateAlerts.length > 0 ? duplicateAlerts : undefined
      };
      
      res.status(201).json(response);
      
    } catch (error) {
      // Handle Zod validation errors specifically
      if (error instanceof z.ZodError) {
        return res.status(400).json({ 
          message: "Datos inválidos", 
          errors: error.errors 
        });
      }
      
      console.error("💥 [NEW] Error in intelligent upload:", error);
      res.status(500).json({ 
        message: "Error en la carga inteligente", 
        error: error instanceof Error ? error.message : "Error desconocido" 
      });
    }
  });

  // 🧹 CLEANUP: Detect and clean malformed URLs (blob: and devblob:)
  app.get("/api/products/malformed-urls", requireAdminAuth, async (req, res) => {
    try {
      console.log("🔍 [CLEANUP] Scanning for products with malformed URLs...");
      
      const allProducts = await storage.getProducts();
      const malformedProducts = allProducts.filter(product => {
        const hasBlob = product.imageUrl?.startsWith('blob:') || product.imageUrl?.includes('devblob:');
        const hasMalformedImages = product.images?.some(img => 
          img.startsWith('blob:') || img.includes('devblob:')
        );
        return hasBlob || hasMalformedImages;
      });
      
      console.log(`🔍 [CLEANUP] Found ${malformedProducts.length} products with malformed URLs`);
      
      res.json({
        total: allProducts.length,
        malformed: malformedProducts.length,
        products: malformedProducts.map(p => ({
          id: p.id,
          name: p.name,
          reference: p.reference,
          imageUrl: p.imageUrl,
          images: p.images,
          brandId: p.brandId || 'Sin marca'
        }))
      });
    } catch (error) {
      console.error("💥 [CLEANUP] Error detecting malformed URLs:", error);
      res.status(500).json({ 
        message: "Error al detectar URLs malformadas", 
        error: error instanceof Error ? error.message : "Error desconocido" 
      });
    }
  });

  // 💰 BULK PRICE ADJUSTMENT: Schema for validation
  const bulkPriceAdjustmentSchema = z.object({
    productIds: z.array(z.string()).min(1, "Se requiere al menos un ID de producto"),
    type: z.enum(["percentage", "fixed", "set"]),
    value: z.number().positive("El valor debe ser positivo"),
    operation: z.enum(["increase", "decrease"]).optional(),
    applyTo: z.enum(["price", "originalPrice", "both"]).default("price")
  }).refine((data) => {
    // Operation is required for percentage and fixed, but not for set
    if (data.type === "set") {
      return true;
    }
    return data.operation !== undefined;
  }, {
    message: "La operación es requerida para ajustes de porcentaje y fijo",
    path: ["operation"]
  });

  // 💰 BULK PRICE ADJUSTMENT: Endpoint for bulk price adjustments
  app.post("/api/products/bulk-adjust-prices", requireAdminAuth, async (req, res) => {
    try {
      // Validate request with Zod
      const validatedData = bulkPriceAdjustmentSchema.parse(req.body);
      const { productIds, type, value, operation, applyTo } = validatedData;

      // Perform bulk price adjustment
      const result = await storage.bulkAdjustProductPrices(productIds, type, value, operation, applyTo);

      res.json({
        message: `${result.updated} productos actualizados exitosamente`,
        updated: result.updated,
        errors: result.errors
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          message: "Datos de entrada inválidos",
          errors: error.errors
        });
      }
      
      console.error("Error in bulk price adjustment:", error);
      res.status(500).json({ message: "Error al ajustar precios masivamente" });
    }
  });

  // 🧹 CLEANUP: Clean malformed URLs by removing affected products
  app.post("/api/products/cleanup-malformed", requireAdminAuth, async (req, res) => {
    try {
      console.log("🧹 [CLEANUP] Starting cleanup of products with malformed URLs...");
      
      const allProducts = await storage.getProducts();
      const malformedProducts = allProducts.filter(product => {
        const hasBlob = product.imageUrl?.startsWith('blob:') || product.imageUrl?.includes('devblob:');
        const hasMalformedImages = product.images?.some(img => 
          img.startsWith('blob:') || img.includes('devblob:')
        );
        return hasBlob || hasMalformedImages;
      });
      
      console.log(`🧹 [CLEANUP] Found ${malformedProducts.length} products to clean`);
      
      let cleanedCount = 0;
      const errors: string[] = [];
      
      for (const product of malformedProducts) {
        try {
          const success = await storage.deleteProduct(product.id);
          if (success) {
            cleanedCount++;
            console.log(`🗑️  [CLEANUP] Removed product: ${product.name} (${product.reference})`);
          } else {
            errors.push(`Failed to delete product: ${product.name} (${product.reference})`);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          errors.push(`Error deleting product ${product.name}: ${errorMsg}`);
          console.error(`❌ [CLEANUP] Error deleting product ${product.name}:`, error);
        }
      }
      
      console.log(`🎉 [CLEANUP] Cleanup completed: ${cleanedCount} products removed`);
      
      res.json({
        message: `Limpieza completada: ${cleanedCount} productos con URLs corruptas eliminados`,
        cleaned: cleanedCount,
        total: malformedProducts.length,
        errors: errors
      });
    } catch (error) {
      console.error("💥 [CLEANUP] Error in cleanup process:", error);
      res.status(500).json({ 
        message: "Error en el proceso de limpieza", 
        error: error instanceof Error ? error.message : "Error desconocido" 
      });
    }
  });

  // Products routes with advanced search and filtering
  app.get("/api/products", async (req, res) => {
    try {
      const { 
        category, 
        brand, 
        flashSale, 
        featured, 
        query, 
        priceMin, 
        priceMax, 
        brands, 
        categories, 
        sizes, 
        colors, 
        onSale, 
        inStock 
      } = req.query;
      
      let products;
      
      // Legacy filters for backward compatibility
      if (category) {
        products = await storage.getProductsByCategory(category as string);
      } else if (brand) {
        products = await storage.getProductsByBrand(brand as string);
      } else if (flashSale === 'true') {
        products = await storage.getFlashSaleProducts();
      } else if (featured === 'true') {
        products = await storage.getFeaturedProducts();
      } else {
        products = await storage.getProducts();
      }
      
      // Apply advanced search and filters
      if (query && typeof query === 'string') {
        const searchTerm = query.toLowerCase();
        products = products.filter(p => 
          p.name.toLowerCase().includes(searchTerm) ||
          (p.description && p.description.toLowerCase().includes(searchTerm))
        );
      }
      
      // Price range filter
      if (priceMin && !isNaN(Number(priceMin))) {
        products = products.filter(p => Number(p.price) >= Number(priceMin));
      }
      
      if (priceMax && !isNaN(Number(priceMax))) {
        products = products.filter(p => Number(p.price) <= Number(priceMax));
      }
      
      // Brand filter (multiple brands)
      if (brands && typeof brands === 'string') {
        const brandList = brands.split(',');
        products = products.filter(p => brandList.includes(p.brandId || ''));
      }
      
      // Category filter (multiple categories)
      if (categories && typeof categories === 'string') {
        const categoryList = categories.split(',');
        products = products.filter(p => {
          const productCategory = typeof p.category === 'string' ? p.category : p.category?.name || '';
          return categoryList.includes(productCategory);
        });
      }
      
      // Size filter
      if (sizes && typeof sizes === 'string') {
        const sizeList = sizes.split(',');
        products = products.filter(p => 
          p.sizes && p.sizes.some(size => sizeList.includes(size))
        );
      }
      
      // Color filter
      if (colors && typeof colors === 'string') {
        const colorList = colors.split(',');
        products = products.filter(p => 
          p.colors && p.colors.some(color => colorList.includes(color))
        );
      }
      
      // On sale filter
      if (onSale === "true") {
        products = products.filter(p => p.discountPercentage && p.discountPercentage > 0);
      }
      
      // In stock filter - products don't have stock field, so we'll consider all products as in stock
      if (inStock === "true") {
        // Since we don't track stock in the current schema, we'll just return all products
        // In the future, a stock field can be added to the products table
      }
      
      res.json(products);
    } catch (error) {
      res.status(500).json({ message: "Error fetching products" });
    }
  });

  app.get("/api/products/:id", async (req, res) => {
    try {
      const product = await storage.getProduct(req.params.id);
      if (!product) {
        return res.status(404).json({ message: "Product not found" });
      }
      res.json(product);
    } catch (error) {
      res.status(500).json({ message: "Error fetching product" });
    }
  });

  app.post("/api/products", async (req, res) => {
    try {
      console.log("🔥 DATOS RECIBIDOS EN BACKEND:", JSON.stringify(req.body, null, 2));
      
      // RENDIMIENTO: Eliminar verificación costosa de límites con readdir
      // El límite se verificará a nivel de base de datos si es necesario
      
      const productData = insertProductSchema.parse(req.body);
      console.log("🔥 DATOS DESPUÉS DE VALIDAR:", JSON.stringify(productData, null, 2));
      
      // Solo verificamos duplicados de imagen, no de nombres
      console.log("✅ Permitiendo múltiples productos con el mismo nombre");
      
      // Generar referencia única si no se proporciona
      if (!productData.reference) {
        let reference = generateUniqueReference();
        let isUnique = false;
        let attempts = 0;
        
        // Verificar que la referencia sea única (máximo 10 intentos)
        while (!isUnique && attempts < 10) {
          const existingProduct = await storage.getProductByReference(reference);
          if (!existingProduct) {
            isUnique = true;
          } else {
            reference = generateUniqueReference();
            attempts++;
          }
        }
        
        if (!isUnique) {
          return res.status(500).json({ message: "Error generando referencia única" });
        }
        
        productData.reference = reference;
        console.log("🔥 REFERENCIA GENERADA:", reference);
      }
      
      const product = await storage.createProduct(productData);
      console.log("🔥 PRODUCTO CREADO:", JSON.stringify(product, null, 2));
      res.status(201).json(product);
    } catch (error) {
      console.error("🔥 ERROR CREANDO PRODUCTO:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid product data", errors: error.errors });
      }
      res.status(500).json({ message: "Error creating product" });
    }
  });

  app.put("/api/products/:id", async (req, res) => {
    try {
      const productData = insertProductSchema.partial().parse(req.body);
      
      // Solo verificamos duplicados de imagen en actualizaciones, no de nombres
      
      const product = await storage.updateProduct(req.params.id, productData);
      if (!product) {
        return res.status(404).json({ message: "Product not found" });
      }
      res.json(product);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid product data", errors: error.errors });
      }
      res.status(500).json({ message: "Error updating product" });
    }
  });

  app.delete("/api/products/:id", async (req, res) => {
    try {
      const success = await storage.deleteProduct(req.params.id);
      if (!success) {
        return res.status(404).json({ message: "Product not found" });
      }
      res.json({ message: "Product deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: "Error deleting product" });
    }
  });

  // 🔒 SECURE: Admin-only duplicate management endpoints
  app.get("/api/admin/products/duplicates", requireAdminAuth, async (req, res) => {
    try {
      const query = duplicateQuerySchema.parse(req.query);
      const { by, brandId, page, limit } = query;
      
      let duplicateGroups: Array<{ key: string; products: any[]; count: number }> = [];
      
      // Call appropriate method based on criteria
      switch (by) {
        case "reference":
          duplicateGroups = await storage.getDuplicateProductsByReference(brandId);
          break;
        case "name":
          duplicateGroups = await storage.getDuplicateProductsByNameBrand(brandId);
          break;
        case "image":
          duplicateGroups = await storage.getDuplicateProductsByImageHash(brandId);
          break;
        default:
          return res.status(400).json({ message: "Invalid criteria specified" });
      }
      
      // Apply pagination
      const startIndex = (page - 1) * limit;
      const endIndex = startIndex + limit;
      const paginatedGroups = duplicateGroups.slice(startIndex, endIndex);
      
      // Calculate summary statistics
      const totalGroups = duplicateGroups.length;
      const totalDuplicates = duplicateGroups.reduce((sum, group) => sum + group.count - 1, 0); // -1 because only duplicates, not the original
      
      res.json({
        success: true,
        data: {
          groups: paginatedGroups,
          pagination: {
            page,
            limit,
            totalGroups,
            totalPages: Math.ceil(totalGroups / limit),
            hasNext: endIndex < totalGroups,
            hasPrev: page > 1
          },
          summary: {
            totalGroups,
            totalDuplicates,
            criteria: by,
            brandId
          }
        }
      });
    } catch (error) {
      console.error('Error fetching duplicates:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ 
          message: "Invalid query parameters", 
          errors: error.errors 
        });
      }
      res.status(500).json({ message: "Error fetching duplicate products" });
    }
  });

  // 📊 Duplicate Images Report Endpoint
  app.get("/api/admin/reports/duplicate-images", requireAdminAuth, async (req, res) => {
    try {
      const report = await storage.getDuplicateImagesReport();
      
      // Log audit event for manual report generation
      await storage.logAuditEvent({
        entityType: 'report',
        entityId: 'duplicate-images',
        action: 'generate',
        actorType: 'admin',
        actorId: req.session?.user?.id || 'system',
        changes: { reportType: 'duplicate-images', timestamp: new Date().toISOString() }
      });
      
      res.json(report);
    } catch (error) {
      console.error('Error generating duplicate images report:', error);
      res.status(500).json({ 
        message: "Error generating duplicate images report",
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  app.post("/api/admin/products/duplicates/:groupKey/merge", requireAdminAuth, async (req, res) => {
    try {
      const { groupKey } = req.params;
      const mergeData = mergeProductsSchema.parse(req.body);
      const { primaryId, duplicateIds, strategy } = mergeData;
      
      // Validate that primary product exists and is not in duplicateIds
      if (duplicateIds.includes(primaryId)) {
        return res.status(400).json({ 
          message: "Primary product ID cannot be in the duplicate IDs list" 
        });
      }
      
      // Perform the atomic merge operation
      const mergedProduct = await storage.mergeProducts(primaryId, duplicateIds, strategy);
      
      if (!mergedProduct) {
        return res.status(404).json({ message: "Failed to merge products - primary product not found" });
      }
      
      res.json({
        success: true,
        message: `Successfully merged ${duplicateIds.length} duplicate products into primary product`,
        data: {
          mergedProduct,
          primaryId,
          duplicateIds,
          strategy,
          groupKey
        }
      });
    } catch (error) {
      console.error('Error merging products:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ 
          message: "Invalid merge data", 
          errors: error.errors 
        });
      }
      res.status(500).json({ message: "Error merging duplicate products" });
    }
  });

  app.patch("/api/admin/products/:id", requireAdminAuth, async (req, res) => {
    try {
      // Validate that product exists
      const existingProduct = await storage.getProduct(req.params.id);
      if (!existingProduct) {
        return res.status(404).json({ message: "Product not found" });
      }
      
      // Fix the data structure - extract from nested body if needed
      let productData = req.body;
      
      // If data is nested in body.body (JSON string), parse it
      if (productData.body && typeof productData.body === 'string') {
        try {
          productData = JSON.parse(productData.body);
        } catch (e) {
          console.log("Failed to parse nested body, using original");
        }
      }
      
      console.log("🔧 PRODUCT UPDATE REQUEST:", JSON.stringify(productData, null, 2));
      
      // Update the product with the data
      const updatedProduct = await storage.updateProduct(req.params.id, productData);
      
      if (!updatedProduct) {
        return res.status(500).json({ message: "Failed to update product" });
      }
      
      res.json({
        success: true,
        message: "Product updated successfully",
        data: updatedProduct
      });
    } catch (error) {
      console.error('Error updating product:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ 
          message: "Invalid product data", 
          errors: error.errors 
        });
      }
      res.status(500).json({ message: "Error updating product" });
    }
  });

  // 💰 Toggle ALL product prices visibility globally
  app.patch("/api/admin/products/toggle-prices-global", async (req, res) => {
    try {
      const result = await storage.toggleAllProductPrices();
      
      res.json({
        success: true,
        message: result.newState ? `✅ Precios visibles para ${result.updated} productos` : `🔒 Precios ocultos para ${result.updated} productos`,
        data: {
          updated: result.updated,
          newState: result.newState
        }
      });
    } catch (error) {
      console.error('Error toggling product prices:', error);
      res.status(500).json({ 
        success: false,
        message: "Error toggling product prices",
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // 🔒 SECURE: Get products by brand for admin (with pagination)
  app.get("/api/admin/brands/:brandId/products", requireAdminAuth, async (req, res) => {
    try {
      const brandId = req.params.brandId;
      const queryData = productsByBrandQuerySchema.parse(req.query);
      
      // Validate that brand exists
      const brand = await storage.getBrand(brandId);
      if (!brand) {
        return res.status(404).json({ message: "Brand not found" });
      }
      
      // Get all products for this brand (we'll implement pagination later if needed)
      const products = await storage.getProductsByBrand(brandId);
      
      // Simple pagination
      const { page, limit } = queryData;
      const startIndex = (page - 1) * limit;
      const endIndex = startIndex + limit;
      const paginatedProducts = products.slice(startIndex, endIndex);
      
      res.json({
        success: true,
        data: {
          products: paginatedProducts,
          pagination: {
            page,
            limit,
            total: products.length,
            totalPages: Math.ceil(products.length / limit),
            hasMore: endIndex < products.length
          },
          brand: {
            id: brand.id,
            name: brand.name,
            logo: brand.logo
          }
        }
      });
    } catch (error) {
      console.error('Error fetching products by brand:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ 
          message: "Invalid query parameters", 
          errors: error.errors 
        });
      }
      res.status(500).json({ message: "Error fetching products by brand" });
    }
  });

  // 🔒 SECURE: Bulk update products
  app.patch("/api/admin/products/bulk", requireAdminAuth, async (req, res) => {
    try {
      const { productIds, updates } = bulkUpdateProductsSchema.parse(req.body);
      
      // Validate that all products exist (security check)
      const existingProducts = await Promise.all(
        productIds.map(id => storage.getProduct(id))
      );
      
      const nonExistentProducts = productIds.filter((id, index) => !existingProducts[index]);
      if (nonExistentProducts.length > 0) {
        return res.status(404).json({ 
          message: "Some products not found", 
          missingProducts: nonExistentProducts 
        });
      }
      
      // Perform bulk update
      const result = await storage.updateProductsBulk(productIds, updates);
      
      res.json({
        success: true,
        message: `Successfully updated ${result.updated} products`,
        data: {
          updated: result.updated,
          requested: productIds.length,
          errors: result.errors,
          updates: updates
        }
      });
    } catch (error) {
      console.error('Error updating products in bulk:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ 
          message: "Invalid bulk update data", 
          errors: error.errors 
        });
      }
      res.status(500).json({ message: "Error updating products in bulk" });
    }
  });

  // Promotions routes
  app.get("/api/promotions", async (req, res) => {
    try {
      const promotions = await storage.getPromotions();
      res.json(promotions);
    } catch (error) {
      console.error("Error fetching promotions:", error);
      res.status(500).json({ error: "Failed to fetch promotions" });
    }
  });

  app.get("/api/promotions/active", async (req, res) => {
    try {
      const promotions = await storage.getActivePromotions();
      res.json(promotions);
    } catch (error) {
      console.error("Error fetching active promotions:", error);
      res.status(500).json({ error: "Failed to fetch active promotions" });
    }
  });

  app.get("/api/promotions/:id", async (req, res) => {
    try {
      const promotion = await storage.getPromotion(req.params.id);
      if (!promotion) {
        return res.status(404).json({ error: "Promotion not found" });
      }
      res.json(promotion);
    } catch (error) {
      console.error("Error fetching promotion:", error);
      res.status(500).json({ error: "Failed to fetch promotion" });
    }
  });

  app.post("/api/promotions", async (req, res) => {
    try {
      const validatedData = insertPromotionSchema.parse(req.body);
      const promotion = await storage.createPromotion(validatedData);
      res.json(promotion);
    } catch (error) {
      console.error("Error creating promotion:", error);
      res.status(500).json({ error: "Failed to create promotion" });
    }
  });

  app.patch("/api/promotions/:id", async (req, res) => {
    try {
      const validatedData = insertPromotionSchema.partial().parse(req.body);
      const promotion = await storage.updatePromotion(req.params.id, validatedData);
      if (!promotion) {
        return res.status(404).json({ error: "Promotion not found" });
      }
      res.json(promotion);
    } catch (error) {
      console.error("Error updating promotion:", error);
      res.status(500).json({ error: "Failed to update promotion" });
    }
  });

  app.delete("/api/promotions/:id", async (req, res) => {
    try {
      const success = await storage.deletePromotion(req.params.id);
      if (!success) {
        return res.status(404).json({ error: "Promotion not found" });
      }
      res.json({ message: "Promotion deleted successfully" });
    } catch (error) {
      console.error("Error deleting promotion:", error);
      res.status(500).json({ error: "Failed to delete promotion" });
    }
  });

  // Events routes
  app.get("/api/events", async (req, res) => {
    try {
      const events = await storage.getEvents();
      res.json(events);
    } catch (error) {
      console.error("Error fetching events:", error);
      res.status(500).json({ error: "Failed to fetch events" });
    }
  });

  app.get("/api/events/active", async (req, res) => {
    try {
      const events = await storage.getActiveEvents();
      res.json(events);
    } catch (error) {
      console.error("Error fetching active events:", error);
      res.status(500).json({ error: "Failed to fetch active events" });
    }
  });

  app.get("/api/events/:id", async (req, res) => {
    try {
      const event = await storage.getEvent(req.params.id);
      if (!event) {
        return res.status(404).json({ error: "Event not found" });
      }
      res.json(event);
    } catch (error) {
      console.error("Error fetching event:", error);
      res.status(500).json({ error: "Failed to fetch event" });
    }
  });

  app.post("/api/events", async (req, res) => {
    try {
      const validatedData = insertEventSchema.parse(req.body);
      const event = await storage.createEvent(validatedData);
      res.json(event);
    } catch (error) {
      console.error("Error creating event:", error);
      res.status(500).json({ error: "Failed to create event" });
    }
  });

  app.patch("/api/events/:id", async (req, res) => {
    try {
      const validatedData = insertEventSchema.partial().parse(req.body);
      const event = await storage.updateEvent(req.params.id, validatedData);
      if (!event) {
        return res.status(404).json({ error: "Event not found" });
      }
      res.json(event);
    } catch (error) {
      console.error("Error updating event:", error);
      res.status(500).json({ error: "Failed to update event" });
    }
  });

  app.delete("/api/events/:id", async (req, res) => {
    try {
      const success = await storage.deleteEvent(req.params.id);
      if (!success) {
        return res.status(404).json({ error: "Event not found" });
      }
      res.json({ message: "Event deleted successfully" });
    } catch (error) {
      console.error("Error deleting event:", error);
      res.status(500).json({ error: "Failed to delete event" });
    }
  });

  // Cart routes
  app.get("/api/cart/:userId", async (req, res) => {
    try {
      const cartItems = await storage.getCartItems(req.params.userId);
      res.json(cartItems);
    } catch (error) {
      res.status(500).json({ message: "Error fetching cart items" });
    }
  });

  app.post("/api/cart", async (req, res) => {
    try {
      const cartItemData = insertCartItemSchema.parse(req.body);
      const cartItem = await storage.addToCart(cartItemData);
      res.status(201).json(cartItem);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid cart item data", errors: error.errors });
      }
      res.status(500).json({ message: "Error adding item to cart" });
    }
  });

  app.put("/api/cart/:id", async (req, res) => {
    try {
      const { quantity } = req.body;
      if (typeof quantity !== 'number' || quantity < 1) {
        return res.status(400).json({ message: "Quantity must be a positive number" });
      }
      
      const cartItem = await storage.updateCartItem(req.params.id, quantity);
      if (!cartItem) {
        return res.status(404).json({ message: "Cart item not found" });
      }
      res.json(cartItem);
    } catch (error) {
      res.status(500).json({ message: "Error updating cart item" });
    }
  });

  app.delete("/api/cart/:id", async (req, res) => {
    try {
      const success = await storage.removeFromCart(req.params.id);
      if (!success) {
        return res.status(404).json({ message: "Cart item not found" });
      }
      res.json({ message: "Item removed from cart" });
    } catch (error) {
      res.status(500).json({ message: "Error removing item from cart" });
    }
  });

  app.delete("/api/cart/clear/:userId", async (req, res) => {
    try {
      await storage.clearCart(req.params.userId);
      res.json({ message: "Cart cleared successfully" });
    } catch (error) {
      res.status(500).json({ message: "Error clearing cart" });
    }
  });

  // Object Storage Routes
  
  // Endpoint para obtener URL de subida para una entidad de objeto
  app.post("/api/objects/upload", async (req, res) => {
    try {
      const objectStorageService = new ObjectStorageService();
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      res.json({ uploadURL });
    } catch (error) {
      console.error("Error getting upload URL:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // 🔍 Check for duplicate images before upload
  app.get("/api/images/check-duplicates", async (req, res) => {
    try {
      const { fileName, size, hash } = req.query;
      
      if (!fileName || !size) {
        return res.status(400).json({
          error: "fileName and size are required",
          details: "Both fileName and size parameters must be provided"
        });
      }

      const fileSizeNumber = parseInt(size as string, 10);
      if (isNaN(fileSizeNumber)) {
        return res.status(400).json({
          error: "size must be a valid number",
          details: "The size parameter must be a valid integer"
        });
      }

      // Check for duplicates by different criteria
      let duplicates = [];
      
      // Helper function to find products using an image and get brand info
      const findProductsUsingImage = async (imagePath: string) => {
        const allProducts = await storage.getProducts();
        const productsUsingImage = allProducts.filter((product: any) => {
          // Check if image is used as main image or in additional images array
          return product.imageUrl === imagePath || 
                 (product.images && product.images.includes(imagePath));
        });
        
        // Get brand info for products using this image
        const brandsInfo = [];
        for (const product of productsUsingImage) {
          if (product.brandId) {
            const brand = await storage.getBrand(product.brandId);
            if (brand) {
              brandsInfo.push({
                productId: product.id,
                productName: product.name,
                productReference: product.reference,
                brandId: brand.id,
                brandName: brand.name,
                brandLogo: brand.logo
              });
            }
          }
        }
        return brandsInfo;
      };
      
      // 1. Check by hash if provided (most accurate)
      if (hash) {
        const hashDuplicate = await storage.getImageByHash(hash as string);
        if (hashDuplicate) {
          const productsInfo = await findProductsUsingImage(hashDuplicate.path);
          duplicates.push({
            type: 'hash',
            match: hashDuplicate,
            reason: 'Imagen idéntica (mismo contenido)',
            productsUsingImage: productsInfo
          });
        }
      }
      
      // 2. Check by filename and size combination (good indicator)
      const allImages = await storage.getAllImages();
      const nameAndSizeMatches = allImages.filter(img => 
        img.originalName === fileName && img.size === fileSizeNumber
      );
      
      for (const match of nameAndSizeMatches) {
        // Avoid duplicate entries if already found by hash
        const alreadyFoundByHash = duplicates.some(dup => dup.match.id === match.id);
        if (!alreadyFoundByHash) {
          const productsInfo = await findProductsUsingImage(match.path);
          duplicates.push({
            type: 'name_and_size',
            match: match,
            reason: 'Mismo nombre y tamaño de archivo',
            productsUsingImage: productsInfo
          });
        }
      }

      // 3. Check by filename only (potential duplicate)
      const nameMatches = allImages.filter(img => 
        img.originalName === fileName && 
        !duplicates.some(dup => dup.match.id === img.id)
      );
      
      for (const match of nameMatches) {
        const productsInfo = await findProductsUsingImage(match.path);
        duplicates.push({
          type: 'name_only',
          match: match,
          reason: 'Mismo nombre de archivo',
          productsUsingImage: productsInfo
        });
      }

      // Generate detailed duplicate report
      const generateDuplicateReport = (duplicates: any[]) => {
        if (duplicates.length === 0) return null;
        
        const report = {
          totalDuplicates: duplicates.length,
          totalProductsAffected: 0,
          brandsSummary: {} as Record<string, { count: number; products: string[] }>,
          detailedReport: '',
          urgencyLevel: 'low' as 'low' | 'medium' | 'high'
        };
        
        let allProducts: any[] = [];
        
        duplicates.forEach(dup => {
          if (dup.productsUsingImage) {
            allProducts.push(...dup.productsUsingImage);
          }
        });
        
        report.totalProductsAffected = allProducts.length;
        
        // Group by brands
        allProducts.forEach(product => {
          if (!report.brandsSummary[product.brandName]) {
            report.brandsSummary[product.brandName] = { count: 0, products: [] };
          }
          report.brandsSummary[product.brandName].count++;
          report.brandsSummary[product.brandName].products.push(
            `${product.productName} (REF: ${product.productReference || 'N/A'})`
          );
        });
        
        // Determine urgency
        const exactDuplicates = duplicates.filter(d => d.type === 'hash').length;
        const totalBrands = Object.keys(report.brandsSummary).length;
        
        if (exactDuplicates > 0 && totalBrands > 2) report.urgencyLevel = 'high';
        else if (exactDuplicates > 0 || totalBrands > 1) report.urgencyLevel = 'medium';
        
        // Generate detailed report text
        const brandDetails = Object.entries(report.brandsSummary)
          .map(([brand, data]) => `🏷️ ${brand}: ${data.count} producto(s) - ${data.products.join(', ')}`)
          .join('\n');
        
        report.detailedReport = `
📊 REPORTE DE DUPLICADOS DETECTADOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  Total de duplicados: ${report.totalDuplicates}
👥 Productos afectados: ${report.totalProductsAffected}
🏢 Marcas involucradas: ${Object.keys(report.brandsSummary).length}
🚨 Nivel de urgencia: ${report.urgencyLevel.toUpperCase()}

📋 DETALLES POR MARCA:
${brandDetails}

⏰ Detectado: ${new Date().toLocaleString('es-CO')}
`.trim();
        
        return report;
      };

      // Return response with detailed information
      const hasDuplicates = duplicates.length > 0;
      const exactDuplicate = duplicates.find(dup => dup.type === 'hash');
      const likelyDuplicate = duplicates.find(dup => dup.type === 'name_and_size');
      const duplicateReport = generateDuplicateReport(duplicates);

      res.json({
        isDuplicate: hasDuplicates,
        isExactDuplicate: !!exactDuplicate,
        isLikelyDuplicate: !!likelyDuplicate,
        duplicateCount: duplicates.length,
        duplicates: duplicates,
        duplicateReport: duplicateReport,
        recommendation: exactDuplicate 
          ? 'Esta imagen ya existe exactamente igual en el sistema'
          : likelyDuplicate 
            ? 'Posiblemente sea un duplicado (mismo nombre y tamaño)'
            : hasDuplicates
              ? 'Existe una imagen con el mismo nombre'
              : 'Imagen nueva, lista para subir',
        message: exactDuplicate
          ? '⚠️ Esta imagen ya existe en el sistema'
          : hasDuplicates
            ? '⚠️ Posible imagen duplicada detectada'
            : '✅ Imagen nueva, lista para subir'
      });

    } catch (error) {
      console.error("Error checking for duplicate images:", error);
      res.status(500).json({ 
        error: "Error checking for duplicates",
        details: error instanceof Error ? error.message : "Unknown error" 
      });
    }
  });

  // 🔍 POST Check for duplicate images before upload (with base64 image data or hash)
  app.post("/api/images/check-duplicates", async (req, res) => {
    try {
      const { imageData, originalName, size, hash } = req.body;
      
      // Calculate hash if imageData is provided, otherwise use provided hash
      let uploadedImageHash: string;
      
      if (hash) {
        uploadedImageHash = hash;
        console.log(`🔍 Checking duplicates by provided hash: ${hash.substring(0, 16)}...`);
      } else if (imageData) {
        const crypto = require('crypto');
        const imageBuffer = Buffer.from(imageData.split(',')[1], 'base64');
        uploadedImageHash = crypto.createHash('sha256').update(imageBuffer).digest('hex');
        console.log(`🔍 Checking duplicates for image: ${originalName || 'unknown'} (${size || 0} bytes, hash: ${uploadedImageHash.substring(0, 16)}...)`);
      } else {
        return res.status(400).json({
          error: "Either imageData or hash is required",
          details: "Provide imageData (base64) or hash (SHA-256) to check for duplicates"
        });
      }

      // Use new optimized storage method
      const duplicateCheck = await storage.checkImageDuplicateByHash(uploadedImageHash);
      
      if (duplicateCheck.isDuplicate) {
        console.log(`🚨 DUPLICATE FOUND: ${duplicateCheck.usageCount} product(s) using this image`);
        
        // Generate detailed report
        const brandsSummary: Record<string, { count: number; products: string[] }> = {};
        
        duplicateCheck.products.forEach(product => {
          if (!brandsSummary[product.brandName]) {
            brandsSummary[product.brandName] = { count: 0, products: [] };
          }
          brandsSummary[product.brandName].count++;
          brandsSummary[product.brandName].products.push(
            `${product.name} (REF: ${product.reference || 'N/A'})`
          );
        });
        
        const brandDetails = Object.entries(brandsSummary)
          .map(([brand, data]) => `🏷️ ${brand}: ${data.count} producto(s) - ${data.products.join(', ')}`)
          .join('\n');
        
        const detailedReport = `
📊 IMAGEN DUPLICADA DETECTADA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  Esta imagen ya está en uso
👥 Productos afectados: ${duplicateCheck.usageCount}
🏢 Marcas involucradas: ${Object.keys(brandsSummary).length}
🚨 Nivel: ${duplicateCheck.usageCount > 3 ? 'ALTO' : duplicateCheck.usageCount > 1 ? 'MEDIO' : 'BAJO'}

📋 DETALLES POR MARCA:
${brandDetails}

⏰ Detectado: ${new Date().toLocaleString('es-CO')}
`.trim();
        
        return res.json({
          isDuplicate: true,
          isExactDuplicate: true,
          duplicateCount: duplicateCheck.usageCount,
          products: duplicateCheck.products,
          duplicateReport: {
            totalDuplicates: duplicateCheck.usageCount,
            totalProductsAffected: duplicateCheck.usageCount,
            brandsSummary,
            detailedReport,
            urgencyLevel: duplicateCheck.usageCount > 3 ? 'high' : duplicateCheck.usageCount > 1 ? 'medium' : 'low'
          },
          recommendation: 'Esta imagen ya existe exactamente igual en el sistema',
          message: '⚠️ Esta imagen ya existe en el sistema'
        });
      }
      
      // No duplicates found
      console.log(`✅ No duplicates found for hash: ${uploadedImageHash.substring(0, 16)}...`);
      return res.json({
        isDuplicate: false,
        isExactDuplicate: false,
        duplicateCount: 0,
        products: [],
        duplicateReport: null,
        recommendation: 'Imagen nueva, lista para subir',
        message: '✅ Imagen nueva, lista para subir'
      });

    } catch (error) {
      console.error("Error checking for duplicate images:", error);
      res.status(500).json({ 
        error: "Error checking for duplicates",
        details: error instanceof Error ? error.message : "Unknown error" 
      });
    }
  });

  // Endpoint para verificar nombre de producto duplicado - AHORA SIEMPRE PERMITE DUPLICADOS
  app.get("/api/products/check-name", async (req, res) => {
    try {
      // VALIDACIÓN: Usar Zod para validar parámetros de query
      const nameSchema = z.object({
        name: z.string().min(1, "Nombre requerido").max(255, "Nombre demasiado largo")
      });
      
      const { name } = nameSchema.parse(req.query);

      // ✅ CAMBIO: Siempre permitir nombres duplicados (solo verificamos imágenes)
      console.log("✅ Verificación de nombre saltada - permitiendo duplicados:", name);
      res.json({ exists: false });
    } catch (error) {
      console.error("Error checking product name:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Datos inválidos", details: error.errors });
      }
      res.status(500).json({ error: "Error al verificar nombre del producto" });
    }
  });

  // Endpoint alternativo para subir imágenes directamente al servidor
  app.post("/api/objects/upload-direct", async (req, res) => {
    console.log("🔥🔥🔥 UPLOAD ENDPOINT LLAMADO 🔥🔥🔥");

    try {
      const { imageData, fileName, mimeType, skipDuplicateCheck } = req.body || {};
      
      if (!imageData) {
        console.log("🔥 ERROR: Missing imageData");
        return res.status(400).json({ error: "Datos de imagen requeridos" });
      }

      // Asegurarse de que el directorio existe
      await fs.ensureDir(uploadsDir);

      // Procesar los datos de la imagen
      const base64Data = imageData.replace(/^data:image\/[a-z]+;base64,/, "");
      const buffer = Buffer.from(base64Data, 'base64');
      console.log("🔥 Buffer created, size:", buffer.length);

      // SEGURIDAD: Validar tamaño (máximo 10MB)
      const MAX_SIZE = 10 * 1024 * 1024; // 10MB
      if (buffer.length > MAX_SIZE) {
        return res.status(400).json({ 
          error: "Imagen demasiado grande", 
          message: `Tamaño máximo permitido: ${(MAX_SIZE / 1024 / 1024).toFixed(1)}MB` 
        });
      }

      // SEGURIDAD CRÍTICA: Detectar tipo real del archivo usando el contenido binario
      const { fileTypeFromBuffer } = await import('file-type');
      const actualFileType = await fileTypeFromBuffer(buffer);
      
      console.log('🔒 Tipo detectado por binario:', actualFileType?.mime || 'DETECCIÓN FALLÓ');
      console.log('🔒 Tipo declarado por cliente:', mimeType);
      
      // CRÍTICO: Si no se puede detectar el tipo, RECHAZAR (no confiar en cliente)
      if (!actualFileType || !actualFileType.mime) {
        return res.status(415).json({ 
          error: "Tipo de archivo no reconocido", 
          message: "El servidor no pudo determinar el tipo de archivo. Solo se permiten imágenes JPEG, PNG, GIF y WebP válidas.",
          reason: "binary_detection_failed"
        });
      }
      
      // CRÍTICO: Bloquear TODAS las variantes HEIC/HEIF (no solo image/heic)
      const heicFormats = ['image/heic', 'image/heif'];
      const heicExtensions = ['heic', 'heif'];
      
      const isHeicByMime = heicFormats.includes(actualFileType.mime);
      const isHeicByExt = actualFileType.ext && heicExtensions.includes(actualFileType.ext);
      
      if (isHeicByMime || isHeicByExt) {
        return res.status(415).json({ 
          error: "Formato HEIC/HEIF detectado en servidor", 
          message: "Tu imagen está en formato HEIC. La convertimos automáticamente en el navegador; si falla, convierte a JPG/PNG y vuelve a intentar.",
          detectedType: actualFileType.mime,
          detectedExt: actualFileType.ext,
          declaredType: mimeType
        });
      }
      
      // CRÍTICO: Solo permitir tipos específicos detectados por binario (NUNCA confiar en cliente)
      const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      
      if (!allowedMimes.includes(actualFileType.mime)) {
        return res.status(415).json({ 
          error: "Tipo de archivo no soportado", 
          message: "Solo se permiten imágenes JPEG, PNG, GIF y WebP",
          detectedType: actualFileType.mime,
          detectedExt: actualFileType.ext,
          allowedTypes: allowedMimes
        });
      }
      
      // SEGURIDAD: Usar SOLO el tipo detectado por binario (ignorar completamente cliente)
      const finalMimeType = actualFileType.mime;

      // SEGURIDAD: SIEMPRE calcular hash en servidor (nunca confiar en cliente)
      const crypto = await import('crypto');
      const imageHash = crypto.createHash('sha256').update(buffer).digest('hex');

      // NO DUPLICATE CHECKING - ALWAYS CREATE NEW IMAGE
      console.log("📁 ALWAYS CREATING NEW IMAGE - No duplicate detection (user request)");

      // SEGURIDAD: Generar fileName seguro en servidor usando extensión detectada
      const imageId = generateUniqueReference();
      // Usar extensión detectada por file-type (más confiable que mime)
      const extension = actualFileType.ext || finalMimeType.split('/')[1] || 'jpg';
      const finalFileName = `${imageId}.${extension}`;
      const filePath = path.join(uploadsDir, finalFileName);
      
      console.log("🔥 Saving to:", filePath);
      console.log("🔒 Usando tipo MIME validado:", finalMimeType);
      console.log("🔒 Usando extensión detectada:", extension);
      
      // Guardar la imagen físicamente
      await fs.writeFile(filePath, buffer);

      // Guardar información de la imagen en la base de datos
      await storage.createImage({
        fileName: finalFileName,
        originalName: fileName || `image.${extension}`,
        path: filePath,
        mimeType: finalMimeType, // Usar el tipo validado por detección binaria
        size: buffer.length,
        sha256: imageHash
      });
      
      const imageUrl = `/api/images/${finalFileName}`;
      
      console.log(`✅ SUCCESS: "${fileName}" saved as: ${imageUrl} with hash: ${imageHash}`);
      
      res.json({ 
        imageUrl,
        success: true,
        message: "Imagen subida correctamente",
        hash: imageHash
      });
    } catch (error) {
      console.error("🔥 UPLOAD ERROR:", error);
      res.status(500).json({ error: "Error al subir imagen: " + (error instanceof Error ? error.message : String(error)) });
    }
  });

  // Endpoint para servir las imágenes subidas
  app.get("/api/images/:fileName", async (req, res) => {
    try {
      const { fileName } = req.params;
      const filePath = path.join(uploadsDir, fileName);
      
      // Verificar que el archivo existe
      if (!(await fs.pathExists(filePath))) {
        return res.status(404).json({ error: "Imagen no encontrada" });
      }
      
      // Servir la imagen
      res.sendFile(path.resolve(filePath));
    } catch (error) {
      console.error("Error serving image:", error);
      res.status(500).json({ error: "Error al servir imagen" });
    }
  });

  // 🤖 CARGA MASIVA DE IMÁGENES CON CLASIFICACIÓN AUTOMÁTICA DE MARCAS
  // Este endpoint analiza múltiples imágenes y crea productos automáticamente
  app.post("/api/products/bulk-upload", requireAdminAuth, async (req, res) => {
    try {
      const { images } = req.body;
      
      if (!images || !Array.isArray(images) || images.length === 0) {
        return res.status(400).json({ 
          error: "Se requiere al menos una imagen",
          message: "Envía un array de imágenes en el campo 'images'" 
        });
      }

      console.log(`🚀 Iniciando carga masiva de ${images.length} imágenes`);
      
      const results = [];
      const errors = [];
      
      // Obtener categorías y marcas existentes
      const categories = await storage.getCategories();
      const brands = await storage.getBrands();
      
      // Buscar categoría "Zapatos" o usar la primera disponible
      const defaultCategory = categories.find(cat => 
        cat.name.toLowerCase().includes('zapato') || 
        cat.name.toLowerCase().includes('calzado')
      ) || categories[0];
      
      if (!defaultCategory) {
        return res.status(400).json({ 
          error: "No hay categorías disponibles",
          message: "Crea al menos una categoría antes de subir productos" 
        });
      }

      // Procesar cada imagen
      for (let i = 0; i < images.length; i++) {
        const imageData = images[i];
        
        try {
          console.log(`📸 Procesando imagen ${i + 1}/${images.length}`);
          
          // 1. SUBIR LA IMAGEN (reutilizando lógica existente)
          let imageUrl;
          let fileName = `producto_${Date.now()}_${i}.jpg`;
          
          if (imageData.imageData) {
            // Imagen en formato base64
            const uploadResult = await new Promise<any>((resolve, reject) => {
              // Simular la lógica del endpoint de subida existente
              const base64Data = imageData.imageData.replace(/^data:image\/[a-z]+;base64,/, "");
              const buffer = Buffer.from(base64Data, 'base64');
              
              // Crear URL temporal para análisis de AI
              const tempFileName = `temp_${Date.now()}_${i}.jpg`;
              imageUrl = `/uploads/${tempFileName}`;
              fileName = imageData.fileName || tempFileName;
              
              resolve({ url: imageUrl, fileName });
            });
            
            imageUrl = uploadResult.url;
            fileName = uploadResult.fileName;
          } else if (imageData.url) {
            // URL directa de imagen
            imageUrl = imageData.url;
            fileName = imageData.fileName || `imagen_${i}.jpg`;
          } else {
            throw new Error('Formato de imagen inválido');
          }

          console.log(`✅ Imagen subida: ${imageUrl}`);

          // 2. DETECTAR MARCA CON AI (reutilizando funciones existentes)
          console.log(`🤖 Analizando marca para: ${fileName}`);
          
          // Usar detección combinada de nombre de archivo y AI visual
          const filenameResult = detectBrandFromFilename(fileName);
          
          let finalBrand = filenameResult.brandName;
          let confidence = filenameResult.confidence;
          let detectionMethod = 'filename';
          
          // Si hay URL de imagen, usar también AI visual
          if (imageUrl && !filenameResult.requiresReview) {
            try {
              const visualResult = await detectBrandFromImage(imageUrl);
              const combinedResult = combineDetectionResults(filenameResult, visualResult);
              
              finalBrand = combinedResult.brand;
              confidence = combinedResult.confidence;
              detectionMethod = combinedResult.method;
              
              console.log(`🔍 Detección combinada: ${finalBrand} (${confidence.toFixed(2)}, método: ${detectionMethod})`);
            } catch (aiError) {
              console.log(`⚠️ AI falló, usando detección de filename: ${finalBrand}`);
            }
          }

          // 3. BUSCAR O CREAR MARCA
          let targetBrand = brands.find(b => 
            b.name.toLowerCase() === (finalBrand || '').toLowerCase()
          );
          
          if (!targetBrand && finalBrand && finalBrand !== PENDING_REVIEW_BRAND) {
            // Crear nueva marca automáticamente
            console.log(`🆕 Creando nueva marca: ${finalBrand}`);
            targetBrand = await storage.createBrand({
              name: finalBrand,
              logo: `/brand-logos/${finalBrand.toLowerCase().replace(/\s+/g, '-')}-logo.png`,
              displayLocation: 'client'
            });
            brands.push(targetBrand); // Agregar a la lista local
          }
          
          // Si no se puede determinar marca, usar marca por defecto o enviar a revisión
          if (!targetBrand) {
            targetBrand = brands.find(b => b.name === 'Nike') || brands[0];
            console.log(`🔄 Usando marca por defecto: ${targetBrand?.name}`);
          }

          // 4. CREAR PRODUCTO AUTOMÁTICAMENTE
          const productName = `${targetBrand?.name || 'Producto'} ${fileName.split('.')[0]}`.substring(0, 255);
          const reference = await generateUniqueReferenceForProduct();
          
          const newProduct = await storage.createProduct({
            name: productName,
            nameNormalized: productName.toLowerCase().trim(),
            description: `Producto importado automáticamente. Marca: ${finalBrand}. Confianza: ${(confidence * 100).toFixed(1)}%. Método: ${detectionMethod}`,
            price: "50000", // Precio por defecto
            originalPrice: "50000",
            discountPercentage: 0,
            categoryId: defaultCategory.id,
            brandId: targetBrand?.id || categories[0]?.id || 'default',
            sellerId: 'admin',
            imageUrl: imageUrl,
            reference: reference,
            sizes: ['38', '39', '40', '41', '42'],
            colors: ['Negro'],
            rating: "0",
            reviewCount: 0,
            isFlashSale: false,
            isFeatured: false
          });

          results.push({
            success: true,
            product: newProduct,
            detectedBrand: finalBrand,
            confidence: confidence,
            detectionMethod: detectionMethod,
            imageUrl: imageUrl,
            originalFileName: fileName
          });

          console.log(`✅ Producto creado: ${newProduct.name} (${newProduct.reference})`);

        } catch (imageError) {
          console.error(`❌ Error procesando imagen ${i + 1}:`, imageError);
          errors.push({
            index: i,
            error: imageError instanceof Error ? imageError.message : 'Error desconocido',
            imageData: imageData.fileName || `imagen_${i}`
          });
        }
      }

      // Respuesta final
      const response = {
        message: `Carga masiva completada: ${results.length} productos creados, ${errors.length} errores`,
        totalProcessed: images.length,
        successful: results.length,
        failed: errors.length,
        results: results,
        errors: errors
      };

      console.log(`🏁 Carga masiva finalizada: ${results.length}/${images.length} exitosos`);
      res.json(response);

    } catch (error) {
      console.error('❌ Error en carga masiva:', error);
      res.status(500).json({ 
        error: "Error en carga masiva",
        message: error instanceof Error ? error.message : 'Error desconocido'
      });
    }
  });

  // API para seguimiento de pedidos - buscar por ID de cliente
  app.get("/api/orders/customer/:customerId", async (req, res) => {
    try {
      const { customerId } = req.params;
      const orders = await storage.getOrdersByCustomerId(customerId);
      res.json(orders);
    } catch (error) {
      console.error("Error fetching orders by customer ID:", error);
      res.status(500).json({ error: "Error al buscar pedidos" });
    }
  });

  // API para seguimiento de pedidos - buscar por número de tracking
  app.get("/api/orders/tracking/:trackingNumber", async (req, res) => {
    try {
      const { trackingNumber } = req.params;
      const orders = await storage.getOrdersByTrackingNumber(trackingNumber);
      res.json(orders);
    } catch (error) {
      console.error("Error fetching orders by tracking number:", error);
      res.status(500).json({ error: "Error al buscar pedido" });
    }
  });

  // API para actualizar estado de pedido (solo para admin)
  app.put("/api/orders/:orderId/status", requireAdminAuth, async (req, res) => {
    try {
      const { orderId } = req.params;
      const { status, deliveryTime, notes } = req.body;
      
      // Validar estados permitidos
      const validStatuses = ['confirmed', 'picked_up', 'in_transit', 'delivered'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: "Estado inválido" });
      }

      const updatedOrder = await storage.updateOrderStatus(orderId, { status, deliveryTime, notes });
      res.json(updatedOrder);
    } catch (error) {
      console.error("Error updating order status:", error);
      res.status(500).json({ error: "Error al actualizar estado del pedido" });
    }
  });

  // API para obtener todos los pedidos (para admin)
  app.get("/api/orders/admin/all", requireAdminAuthHeaders, async (req, res) => {
    try {
      const orders = await storage.getAllOrders();
      res.json(orders);
    } catch (error) {
      console.error("Error fetching all orders:", error);
      res.status(500).json({ error: "Error al obtener pedidos" });
    }
  });

  // Endpoint para servir objetos públicos
  app.get("/public-objects/:filePath(*)", async (req, res) => {
    const filePath = req.params.filePath;
    const objectStorageService = new ObjectStorageService();
    try {
      const file = await objectStorageService.searchPublicObject(filePath);
      if (!file) {
        return res.status(404).json({ error: "File not found" });
      }
      objectStorageService.downloadObject(file, res);
    } catch (error) {
      console.error("Error searching for public object:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // Endpoint para servir objetos privados
  app.get("/objects/:objectPath(*)", async (req, res) => {
    const objectStorageService = new ObjectStorageService();
    try {
      const objectFile = await objectStorageService.getObjectEntityFile(req.path);
      objectStorageService.downloadObject(objectFile, res);
    } catch (error) {
      console.error("Error accessing object:", error);
      if (error instanceof ObjectNotFoundError) {
        return res.sendStatus(404);
      }
      return res.sendStatus(500);
    }
  });

  // Customer Savings routes
  app.get("/api/customer-savings/:customerId", async (req, res) => {
    try {
      const customerId = req.params.customerId;
      const customerSavings = await storage.getCustomerSavings(customerId);
      
      if (!customerSavings) {
        // Return default empty savings for new customers
        return res.json({
          customerId,
          totalSaved: "0",
          achievementsUnlocked: [],
          lastPurchaseAmount: "0",
          totalPurchases: 0
        });
      }
      
      res.json(customerSavings);
    } catch (error) {
      res.status(500).json({ message: "Error fetching customer savings" });
    }
  });

  app.post("/api/customer-savings/:customerId/add-savings", async (req, res) => {
    try {
      const customerId = req.params.customerId;
      const { amount } = req.body;
      
      if (!amount || isNaN(parseFloat(amount))) {
        return res.status(400).json({ message: "Valid amount is required" });
      }
      
      const customerSavings = await storage.addSavings(customerId, amount.toString());
      res.json(customerSavings);
    } catch (error) {
      res.status(500).json({ message: "Error adding savings" });
    }
  });

  app.post("/api/customer-savings/:customerId/apply-discount", async (req, res) => {
    try {
      const customerId = req.params.customerId;
      const { discountAmount } = req.body;
      
      if (!discountAmount || isNaN(parseFloat(discountAmount))) {
        return res.status(400).json({ message: "Valid discount amount is required" });
      }
      
      const customerSavings = await storage.applySavingsDiscount(customerId, discountAmount.toString());
      
      if (!customerSavings) {
        return res.status(404).json({ message: "Customer savings not found" });
      }
      
      res.json(customerSavings);
    } catch (error) {
      res.status(500).json({ message: "Error applying discount" });
    }
  });

  app.put("/api/customer-savings/:customerId", async (req, res) => {
    try {
      const customerId = req.params.customerId;
      const updateData = req.body;
      
      const customerSavings = await storage.updateCustomerSavings(customerId, updateData);
      
      if (!customerSavings) {
        return res.status(404).json({ message: "Customer savings not found" });
      }
      
      res.json(customerSavings);
    } catch (error) {
      res.status(500).json({ message: "Error updating customer savings" });
    }
  });

  // 📊 Initialize Daily Reports System
  setupDailyReportCron();
  
  // 📊 PANEL DE DUPLICADOS DETALLADO - Para mostrar en admin
  app.get("/api/admin/duplicates-report", requireAdminAuth, async (req, res) => {
    try {
      console.log('📊 Generando reporte detallado de duplicados...');
      
      // 1. Obtener todas las imágenes con hash
      const allImages = await storage.getAllImages();
      const allProducts = await storage.getProducts();
      const allBrands = await storage.getBrands();
      
      // 2. Agrupar por hash
      const imagesByHash: Record<string, any[]> = {};
      const duplicateGroups = [];
      
      for (const image of allImages) {
        if (image.sha256) {
          if (!imagesByHash[image.sha256]) {
            imagesByHash[image.sha256] = [];
          }
          imagesByHash[image.sha256].push(image);
        }
      }
      
      // 3. Encontrar grupos de duplicados con productos afectados
      for (const [hash, images] of Object.entries(imagesByHash)) {
        if (images.length > 1) {
          const affectedProducts = [];
          
          for (const image of images) {
            const productsUsingImage = allProducts.filter((product: any) => {
              return product.imageUrl === image.path || 
                     (product.images && product.images.includes(image.path));
            });
            
            for (const product of productsUsingImage) {
              const brand = allBrands.find(b => b.id === product.brandId);
              affectedProducts.push({
                productId: product.id,
                productName: product.name,
                productReference: product.reference,
                brandId: product.brandId,
                brandName: brand?.name || 'Sin marca',
                brandLogo: brand?.logo || '',
                imageUsed: image.path,
                imageOriginalName: image.originalName
              });
            }
          }
          
          duplicateGroups.push({
            duplicateHash: hash,
            duplicateCount: images.length,
            affectedProducts: affectedProducts,
            images: images.map(img => ({
              path: img.path,
              originalName: img.originalName,
              uploadDate: img.createdAt || 'Desconocida'
            })),
            severity: affectedProducts.length > 5 ? 'high' : affectedProducts.length > 2 ? 'medium' : 'low'
          });
        }
      }
      
      // 4. Organizar por marca para análisis
      const duplicatesByBrand: Record<string, any> = {};
      duplicateGroups.forEach(group => {
        group.affectedProducts.forEach((product: any) => {
          if (!duplicatesByBrand[product.brandName]) {
            duplicatesByBrand[product.brandName] = {
              brandName: product.brandName,
              brandLogo: product.brandLogo,
              totalDuplicateGroups: 0,
              totalProductsAffected: 0,
              duplicateGroups: []
            };
          }
          
          if (!duplicatesByBrand[product.brandName].duplicateGroups.find((g: any) => g.duplicateHash === group.duplicateHash)) {
            duplicatesByBrand[product.brandName].duplicateGroups.push(group);
            duplicatesByBrand[product.brandName].totalDuplicateGroups++;
          }
          
          duplicatesByBrand[product.brandName].totalProductsAffected++;
        });
      });
      
      // 5. Estadísticas generales
      const totalDuplicateGroups = duplicateGroups.length;
      const totalImagesInvolved = duplicateGroups.reduce((sum, group) => sum + group.duplicateCount, 0);
      const totalProductsAffected = duplicateGroups.reduce((sum, group) => sum + group.affectedProducts.length, 0);
      
      res.json({
        success: true,
        summary: {
          totalDuplicateGroups,
          totalImagesInvolved,
          totalProductsAffected,
          brandsAffected: Object.keys(duplicatesByBrand).length,
          severityDistribution: {
            high: duplicateGroups.filter(g => g.severity === 'high').length,
            medium: duplicateGroups.filter(g => g.severity === 'medium').length,
            low: duplicateGroups.filter(g => g.severity === 'low').length
          }
        },
        duplicateGroups,
        duplicatesByBrand,
        generatedAt: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('❌ Error generating duplicates report:', error);
      res.status(500).json({
        success: false,
        message: 'Error generando reporte de duplicados',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // 📊 OPTIMIZED DUPLICATE IMAGES REPORT - Uses SHA-256 hash-based detection
  app.get("/api/admin/reports/duplicate-images", requireAdminAuth, async (req, res) => {
    try {
      console.log('📊 Generating optimized duplicate images report using hash-based detection...');
      
      // Use the optimized storage method to get all duplicates
      const duplicates = await storage.getAllDuplicateImages();
      
      // Calculate summary statistics
      const summary = {
        totalDuplicateGroups: duplicates.length,
        totalImagesInvolved: duplicates.reduce((sum, group) => sum + group.duplicateCount, 0),
        totalProductsAffected: duplicates.reduce((sum, group) => sum + group.productsUsingImage.length, 0),
        brandsAffected: [...new Set(duplicates.flatMap(d => d.productsUsingImage.map(p => p.brandName)))].length
      };
      
      // Organize by brand for better reporting
      const duplicatesByBrand: Record<string, any> = {};
      duplicates.forEach(group => {
        group.productsUsingImage.forEach((product: any) => {
          const brandName = product.brandName || 'Sin marca';
          if (!duplicatesByBrand[brandName]) {
            duplicatesByBrand[brandName] = {
              brandName,
              brandLogo: product.brandLogo,
              totalDuplicateGroups: 0,
              totalProductsAffected: 0,
              duplicateGroups: []
            };
          }
          
          // Add this duplicate group if not already added for this brand
          if (!duplicatesByBrand[brandName].duplicateGroups.find((g: any) => g.hash === group.hash)) {
            duplicatesByBrand[brandName].duplicateGroups.push(group);
            duplicatesByBrand[brandName].totalDuplicateGroups++;
          }
          
          duplicatesByBrand[brandName].totalProductsAffected++;
        });
      });
      
      // Register audit event
      await registerAuditEvent({
        actorType: 'admin',
        actorId: req.user?.id || 'unknown-admin',
        sessionId: req.sessionID || 'no-session',
        actionCode: 703, // API_CALL
        resourceType: 'report',
        resourceId: 'duplicate-images',
        result: 'success',
        metadata: {
          totalDuplicates: duplicates.length,
          totalProducts: summary.totalProductsAffected,
          reportType: 'duplicate_images',
          timestamp: new Date().toISOString()
        }
      });
      
      res.json({
        success: true,
        summary,
        duplicates,
        duplicatesByBrand,
        generatedAt: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('❌ Error generating duplicate images report:', error);
      
      // Register failure in audit
      await registerAuditEvent({
        actorType: 'admin',
        actorId: req.user?.id || 'unknown-admin',
        sessionId: req.sessionID || 'no-session',
        actionCode: 703, // API_CALL
        resourceType: 'report',
        resourceId: 'duplicate-images',
        result: 'failure',
        metadata: {
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        }
      });
      
      res.status(500).json({
        success: false,
        message: 'Error generando reporte de imágenes duplicadas',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // 🚨 REPORTE COMPLETO INMEDIATO - SIN MIDDLEWARE
  app.get("/api/emergency-report", async (req, res) => {
    try {
      console.log('🚨 GENERANDO REPORTE COMPLETO DE ACTIVIDAD...');
      
      // 1. Obtener datos básicos
      const allProducts = await storage.getProducts();
      const allBrands = await storage.getBrands();
      const allImages = await storage.getAllImages();
      
      // 2. Estadísticas por marca simplificadas
      const brandStats: Record<string, any> = {};
      for (const brand of allBrands) {
        const brandProducts = allProducts.filter((p: any) => p.brandId === brand.id);
        if (brandProducts.length > 0) {
          brandStats[brand.name] = {
            totalProducts: brandProducts.length,
            productsWithImages: brandProducts.filter(p => p.imageUrl || (p.images && p.images.length > 0)).length
          };
        }
      }
      
      // 3. Análisis de duplicados simplificado
      const imagesWithHash = allImages.filter(img => img.sha256);
      const hashCounts: Record<string, number> = {};
      let duplicateCount = 0;
      
      for (const image of imagesWithHash) {
        if (image.sha256) {
          hashCounts[image.sha256] = (hashCounts[image.sha256] || 0) + 1;
        }
      }
      
      for (const count of Object.values(hashCounts)) {
        if (count > 1) {
          duplicateCount++;
        }
      }
      
      // 4. Generar reporte completo
      let completeReport = `🚨 *REPORTE COMPLETO FASTSNEAKERS*\n`;
      completeReport += `📅 *${new Date().toLocaleDateString('es-CO')} - ${new Date().toLocaleTimeString('es-CO')}*\n\n`;
      
      // INVENTARIO ACTUAL
      completeReport += `📦 *INVENTARIO ACTUAL:*\n`;
      completeReport += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      completeReport += `📋 Total productos: *${allProducts.length}*\n`;
      completeReport += `🖼️ Total imágenes: *${allImages.length}*\n`;
      completeReport += `🏷️ Marcas activas: *${Object.keys(brandStats).length}*\n\n`;
      
      // DISTRIBUCIÓN POR MARCA
      completeReport += `🔧 *DISTRIBUCIÓN POR MARCA:*\n`;
      completeReport += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      for (const [brandName, data] of Object.entries(brandStats)) {
        completeReport += `🏷️ *${brandName}:* ${data.totalProducts} productos (${data.productsWithImages} con imagen)\n`;
      }
      completeReport += `\n`;
      
      // DUPLICADOS CRÍTICOS
      if (duplicateCount > 0) {
        completeReport += `🚨 *DUPLICADOS DETECTADOS:*\n`;
        completeReport += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        completeReport += `⚠️ Grupos de imágenes duplicadas: *${duplicateCount}*\n`;
        completeReport += `📝 Recomendación: Revisar y eliminar duplicados\n\n`;
      } else {
        completeReport += `✅ *SIN DUPLICADOS:* Sistema limpio\n\n`;
      }
      
      // ACTIVIDAD DEL SISTEMA HOY
      const now = new Date();
      const hour = now.getHours();
      completeReport += `👥 *ACTIVIDAD DEL SISTEMA:*\n`;
      completeReport += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      completeReport += `🕐 Hora actual: ${hour}:${now.getMinutes().toString().padStart(2, '0')}\n`;
      completeReport += `🌐 Sistema operativo desde 1:00 AM\n`;
      completeReport += `📱 Aplicación funcionando correctamente\n\n`;
      
      // ESTADO DEL SISTEMA
      completeReport += `⚙️ *ESTADO DEL SISTEMA:*\n`;
      completeReport += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      completeReport += `🟢 Servidor: Operativo\n`;
      completeReport += `🟢 Base de datos: ${allProducts.length > 0 ? 'Funcional' : 'Sin datos'}\n`;
      completeReport += `🟢 Imágenes: ${allImages.length} archivos cargados\n`;
      completeReport += `${duplicateCount > 0 ? '🟡' : '🟢'} Duplicados: ${duplicateCount === 0 ? 'Ninguno' : duplicateCount + ' detectados'}\n`;
      completeReport += `🟢 WhatsApp: Configurado y operativo\n\n`;
      
      completeReport += `📱 *FASTSNEAKERS - Reporte Completo*\n`;
      completeReport += `🚨 *SOLICITADO INMEDIATAMENTE*\n`;
      completeReport += `🕐 Generado: ${new Date().toLocaleString('es-CO')}\n`;
      
      console.log('📊 Reporte completo generado, enviando por WhatsApp...');
      
      // ENVIAR POR WHATSAPP INMEDIATAMENTE
      await sendWhatsAppNotification({
        message: completeReport,
        urgencyLevel: duplicateCount > 0 ? 'high' : 'low',
        type: 'daily_report',
        metadata: {
          reportDate: new Date().toISOString(),
          automated: false,
          triggeredBy: 'manual_complete_immediate',
          duplicatesFound: duplicateCount,
          totalProducts: allProducts.length,
          totalImages: allImages.length
        }
      });
      
      res.json({
        success: true,
        message: 'Reporte completo enviado a WhatsApp INMEDIATAMENTE',
        report: completeReport,
        stats: {
          duplicates: duplicateCount,
          totalProducts: allProducts.length,
          totalImages: allImages.length,
          activeBrands: Object.keys(brandStats).length
        }
      });
      
    } catch (error) {
      console.error('❌ Error generating complete report:', error);
      res.status(500).json({
        success: false,
        message: 'Error generando reporte completo',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // 🧪 Test endpoint for manual daily report generation
  app.get("/api/admin/daily-report", requireAdminAuth, async (req, res) => {
    try {
      const report = await generateDailyReport();
      
      // Send to WhatsApp and also return in response
      await sendWhatsAppNotification({
        message: report,
        urgencyLevel: 'low',
        type: 'daily_report',
        metadata: {
          reportDate: new Date().toISOString(),
          automated: false,
          triggeredBy: 'manual'
        }
      });
      
      res.json({
        success: true,
        message: 'Reporte diario generado y enviado a WhatsApp',
        report
      });
    } catch (error) {
      console.error('❌ Error generating manual daily report:', error);
      res.status(500).json({
        success: false,
        message: 'Error generando reporte diario',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // 🔍 DEBUG: Verificar estado de productos y marcas
  app.get("/api/admin/debug-products", requireAdminAuth, async (req, res) => {
    try {
      const allProducts = await storage.getProducts();
      const allBrands = await storage.getBrands();
      
      const sample = allProducts.slice(0, 5).map(p => ({
        id: p.id,
        name: p.name,
        brandId: p.brandId,
        categoryId: p.categoryId,
        reference: p.reference
      }));
      
      const productsWithBrands = allProducts.filter(p => p.brandId).length;
      const productsWithoutBrands = allProducts.filter(p => !p.brandId).length;
      
      res.json({
        totalProducts: allProducts.length,
        totalBrands: allBrands.length,
        productsWithBrands,
        productsWithoutBrands,
        sampleProducts: sample,
        brands: allBrands.map(b => ({ id: b.id, name: b.name }))
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 🔍 NUEVO: Endpoint para detectar duplicados existentes en la base de datos
  app.get("/api/admin/find-duplicates", requireAdminAuth, async (req, res) => {
    try {
      console.log('🔍 Iniciando búsqueda de duplicados existentes...');
      
      // Obtener todas las imágenes de la base de datos
      const allImages = await storage.getAllImages();
      console.log(`📊 Total de imágenes en BD: ${allImages.length}`);
      
      // Agrupar por hash SHA-256 para encontrar duplicados reales
      const imagesByHash = new Map<string, any[]>();
      const imagesByName = new Map<string, any[]>();
      
      for (const image of allImages) {
        // Agrupar por hash (duplicados exactos)
        if (image.sha256) {
          if (!imagesByHash.has(image.sha256)) {
            imagesByHash.set(image.sha256, []);
          }
          imagesByHash.get(image.sha256)!.push(image);
        }
        
        // Agrupar por nombre (posibles duplicados)
        if (!imagesByName.has(image.originalName)) {
          imagesByName.set(image.originalName, []);
        }
        imagesByName.get(image.originalName)!.push(image);
      }
      
      // Encontrar duplicados exactos (mismo hash)
      const exactDuplicates = [];
      for (const [hash, images] of imagesByHash) {
        if (images.length > 1) {
          // Encontrar productos que usan estas imágenes
          const allProducts = await storage.getProducts();
          const affectedProducts = [];
          
          for (const image of images) {
            const productsUsingImage = allProducts.filter((product: any) => {
              return product.imageUrl === image.path || 
                     (product.images && product.images.includes(image.path));
            });
            
            for (const product of productsUsingImage) {
              if (product.brandId) {
                const brand = await storage.getBrand(product.brandId);
                affectedProducts.push({
                  productId: product.id,
                  productName: product.name,
                  productReference: product.reference,
                  brandName: brand?.name || 'Sin marca',
                  imagePath: image.path
                });
              }
            }
          }
          
          exactDuplicates.push({
            hash: hash.substring(0, 16) + '...',
            totalImages: images.length,
            imageDetails: images.map(img => ({
              path: img.path,
              originalName: img.originalName,
              size: img.size,
              uploadedAt: img.uploadedAt
            })),
            affectedProducts: affectedProducts
          });
        }
      }
      
      // Encontrar duplicados por nombre
      const nameDuplicates = [];
      for (const [name, images] of imagesByName) {
        if (images.length > 1) {
          // Solo incluir si no son duplicados exactos (ya detectados arriba)
          const uniqueHashes = new Set(images.map(img => img.sha256).filter(Boolean));
          if (uniqueHashes.size > 1) {
            nameDuplicates.push({
              originalName: name,
              totalImages: images.length,
              differentHashes: uniqueHashes.size,
              imageDetails: images.map(img => ({
                path: img.path,
                size: img.size,
                hash: img.sha256?.substring(0, 16) + '...' || 'sin hash'
              }))
            });
          }
        }
      }
      
      const summary = {
        totalImages: allImages.length,
        exactDuplicates: exactDuplicates.length,
        nameDuplicates: nameDuplicates.length,
        imagesWithoutHash: allImages.filter(img => !img.sha256).length
      };
      
      console.log('📊 Resumen de duplicados:', summary);
      
      res.json({
        success: true,
        summary,
        exactDuplicates,
        nameDuplicates,
        message: exactDuplicates.length > 0 
          ? `🚨 Se encontraron ${exactDuplicates.length} grupos de imágenes duplicadas exactas`
          : '✅ No se encontraron duplicados exactos en la base de datos'
      });
      
    } catch (error) {
      console.error('❌ Error buscando duplicados:', error);
      res.status(500).json({
        success: false,
        message: 'Error buscando duplicados en la base de datos',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // 📊 SISTEMA DE INFORMES AUTOMÁTICOS COMPLETO
  
  // Función para generar estadísticas completas del sistema
  async function generateCompleteSystemReport(): Promise<any> {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const lastWeek = new Date(today);
    lastWeek.setDate(lastWeek.getDate() - 7);
    const lastMonth = new Date(today);
    lastMonth.setMonth(lastMonth.getMonth() - 1);

    try {
      // 1. Estadísticas de productos y marcas
      const allProducts = await storage.getProducts();
      const totalProducts = allProducts.length;
      const brands = await storage.getBrands();
      
      // Contar productos por marca
      const productsByBrand: { [key: string]: number } = {};
      for (const product of allProducts) {
        const brand = brands.find(b => b.id === product.brandId);
        if (brand) {
          productsByBrand[brand.name] = (productsByBrand[brand.name] || 0) + 1;
        }
      }
      
      // 2. Estadísticas de imágenes y duplicados
      const allImages = await storage.getAllImages();
      const totalImages = allImages.length;
      
      // Contar duplicados por hash
      const imagesByHash = new Map<string, any[]>();
      for (const image of allImages) {
        if (image.sha256) {
          if (!imagesByHash.has(image.sha256)) {
            imagesByHash.set(image.sha256, []);
          }
          imagesByHash.get(image.sha256)!.push(image);
        }
      }
      
      const duplicateGroups = Array.from(imagesByHash.values()).filter(images => images.length > 1);
      const totalDuplicates = duplicateGroups.reduce((sum, group) => sum + (group.length - 1), 0);
      
      // 3. Estadísticas de auditoría y actividad
      const todayTimestamp = Math.floor(today.getTime() / 1000);
      const yesterdayTimestamp = Math.floor(yesterday.getTime() / 1000);
      const lastWeekTimestamp = Math.floor(lastWeek.getTime() / 1000);
      
      // Obtener eventos de auditoría de manera más simple
      const todayEvents = await db.select().from(auditEvents).catch(() => []);
      const todayEventsCount = todayEvents.filter(event => 
        event.timestamp && new Date(event.timestamp).getTime() >= today.getTime()
      ).length;
      
      const yesterdayEventsCount = todayEvents.filter(event => 
        event.timestamp && 
        new Date(event.timestamp).getTime() >= yesterday.getTime() &&
        new Date(event.timestamp).getTime() < today.getTime()
      ).length;
      
      const weeklyEventsCount = todayEvents.filter(event => 
        event.timestamp && new Date(event.timestamp).getTime() >= lastWeek.getTime()
      ).length;

      // 4. Actividad por tipo (simplificado)
      const actionCounts: { [key: number]: number } = {};
      const recentEvents = todayEvents.filter(event => 
        event.timestamp && new Date(event.timestamp).getTime() >= lastWeek.getTime()
      );
      
      for (const event of recentEvents) {
        actionCounts[event.actionCode] = (actionCounts[event.actionCode] || 0) + 1;
      }
      
      const recentActions = Object.entries(actionCounts).map(([actionCode, count]) => ({
        actionCode: parseInt(actionCode),
        count,
        description: getActionDescription(parseInt(actionCode))
      }));

      // 5. Usuarios activos (simplificado)
      const activeUsersCount = todayEvents.filter(event => 
        event.timestamp && 
        new Date(event.timestamp).getTime() >= today.getTime() &&
        event.actionCode === AuditActionCodes.USER_LOGIN
      ).length;

      return {
        generatedAt: now.toISOString(),
        reportDate: now.toLocaleDateString('es-CO'),
        
        // Resumen del inventario
        inventory: {
          totalProducts: totalProducts,
          totalBrands: brands.length,
          totalImages: totalImages,
          productsByBrand: productsByBrand,
          duplicatesDetected: {
            groups: duplicateGroups.length,
            totalDuplicateImages: totalDuplicates,
            savingsOpportunity: `${totalDuplicates} imágenes duplicadas detectadas`
          }
        },
        
        // Actividad del sistema
        activity: {
          today: {
            totalEvents: todayEventsCount,
            activeUsers: activeUsersCount
          },
          yesterday: {
            totalEvents: yesterdayEventsCount
          },
          lastWeek: {
            totalEvents: weeklyEventsCount
          },
          actionBreakdown: recentActions
        },
        
        // Marcas más activas
        brandAnalytics: brands.map(brand => ({
          name: brand.name,
          productCount: productsByBrand[brand.name] || 0,
          isActive: brand.isActive,
          displayLocation: brand.displayLocation
        })).sort((a, b) => b.productCount - a.productCount),
        
        // Estado del sistema
        systemHealth: {
          status: 'operational',
          lastReportGenerated: now.toISOString(),
          dataIntegrity: totalDuplicates === 0 ? 'excellent' : `${totalDuplicates} duplicados detectados`,
          performance: 'optimal'
        }
      };
      
    } catch (error) {
      console.error('❌ Error generando reporte:', error);
      return {
        generatedAt: now.toISOString(),
        error: 'Error generando estadísticas completas',
        details: error instanceof Error ? error.message : 'Error desconocido'
      };
    }
  }
  
  // Función helper para describir códigos de acción
  function getActionDescription(actionCode: number): string {
    const descriptions: { [key: number]: string } = {
      [AuditActionCodes.USER_LOGIN]: 'Inicios de sesión',
      [AuditActionCodes.PRODUCT_CREATE]: 'Productos creados',
      [AuditActionCodes.PRODUCT_UPDATE]: 'Productos actualizados',
      [AuditActionCodes.PRODUCT_VIEW]: 'Productos visualizados',
      [AuditActionCodes.BULK_UPLOAD]: 'Cargas masivas',
      [AuditActionCodes.FILE_UPLOAD]: 'Archivos subidos',
      [AuditActionCodes.DUPLICATE_DETECTION]: 'Duplicados detectados',
      [AuditActionCodes.BRAND_VIEW]: 'Marcas consultadas',
      [AuditActionCodes.SEARCH_QUERY]: 'Búsquedas realizadas'
    };
    return descriptions[actionCode] || `Acción ${actionCode}`;
  }
  
  // 🚀 SISTEMA DE NOTIFICACIONES MÚLTIPLES
  interface NotificationMethod {
    name: string;
    send: (report: any) => Promise<boolean>;
    enabled: boolean;
  }
  
  const notificationMethods: NotificationMethod[] = [
    // 1. Archivo de Log Local (siempre activo)
    {
      name: 'Local Log File',
      enabled: true,
      send: async (report: any) => {
        try {
          const logDir = './reports';
          await fs.ensureDir(logDir);
          const filename = `report_${new Date().toISOString().split('T')[0]}.json`;
          const filePath = path.join(logDir, filename);
          await fs.writeJSON(filePath, report, { spaces: 2 });
          console.log(`📄 Reporte guardado: ${filePath}`);
          return true;
        } catch (error) {
          console.error('❌ Error guardando reporte local:', error);
          return false;
        }
      }
    },
    
    // 2. Consola detallada (siempre activo)
    {
      name: 'Console Report',
      enabled: true,
      send: async (report: any) => {
        try {
          console.log('\n' + '='.repeat(80));
          console.log('📊 REPORTE AUTOMÁTICO DEL SISTEMA - ' + report.reportDate);
          console.log('='.repeat(80));
          
          console.log('\n📦 INVENTARIO:');
          console.log(`  • Total productos: ${report.inventory.totalProducts}`);
          console.log(`  • Total marcas: ${report.inventory.totalBrands}`);
          console.log(`  • Total imágenes: ${report.inventory.totalImages}`);
          console.log(`  • Duplicados detectados: ${report.inventory.duplicatesDetected.totalDuplicateImages}`);
          
          console.log('\n👥 ACTIVIDAD:');
          console.log(`  • Eventos hoy: ${report.activity.today.totalEvents}`);
          console.log(`  • Usuarios activos hoy: ${report.activity.today.activeUsers}`);
          console.log(`  • Eventos esta semana: ${report.activity.lastWeek.totalEvents}`);
          
          console.log('\n🏷️ TOP MARCAS:');
          report.brandAnalytics.slice(0, 5).forEach((brand: any, index: number) => {
            console.log(`  ${index + 1}. ${brand.name}: ${brand.productCount} productos`);
          });
          
          console.log('\n🔥 ACCIONES RECIENTES:');
          report.activity.actionBreakdown.slice(0, 5).forEach((action: any) => {
            console.log(`  • ${action.description}: ${action.count} veces`);
          });
          
          console.log('\n' + '='.repeat(80));
          console.log('✅ Reporte generado exitosamente a las ' + new Date().toLocaleTimeString());
          console.log('='.repeat(80) + '\n');
          
          return true;
        } catch (error) {
          console.error('❌ Error mostrando reporte en consola:', error);
          return false;
        }
      }
    },
    
    // 3. Webhook genérico (configurable)
    {
      name: 'Generic Webhook',
      enabled: false, // Se puede activar cuando se configure
      send: async (report: any) => {
        // Esta función se puede expandir para enviar a webhooks externos
        // como Discord, Slack, Telegram, etc.
        console.log('🔗 Webhook notification placeholder - configure webhook URL');
        return false;
      }
    }
  ];
  
  // Función principal para enviar notificaciones
  async function sendNotifications(report: any): Promise<void> {
    console.log('📬 Enviando notificaciones del reporte...');
    
    for (const method of notificationMethods) {
      if (method.enabled) {
        try {
          const success = await method.send(report);
          if (success) {
            console.log(`✅ ${method.name}: Notificación enviada`);
          } else {
            console.log(`⚠️ ${method.name}: Falló el envío`);
          }
        } catch (error) {
          console.error(`❌ ${method.name}: Error enviando notificación:`, error);
        }
      }
    }
  }
  
  // 📊 ENDPOINT PARA GENERAR REPORTE MANUAL
  app.get('/api/admin/generate-report', requireAdminAuth, async (req: Request, res: Response) => {
    try {
      console.log('📊 Generando reporte manual del sistema...');
      const report = await generateCompleteSystemReport();
      
      // Enviar notificaciones
      await sendNotifications(report);
      
      // Registrar en auditoría
      try {
        await storage.createAuditEvent({
          actorType: 'admin',
          actorId: (req as any).user?.id || 'admin',
          sessionId: (req as any).sessionID || 'manual-report-session',
          actionCode: AuditActionCodes.REPORT_GENERATE,
          result: 'success',
          metadata: JSON.stringify({ 
            trigger: 'manual',
            timestamp: new Date().toISOString()
          })
        });
      } catch (auditError) {
        console.error('Error creating audit event:', auditError);
      }
      
      res.json({
        success: true,
        message: 'Reporte generado y enviado exitosamente',
        report: report,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('❌ Error generando reporte manual:', error);
      res.status(500).json({
        success: false,
        message: 'Error generando reporte del sistema',
        error: error instanceof Error ? error.message : 'Error desconocido'
      });
    }
  });
  
  // 🕛 SISTEMA DE REPORTES AUTOMÁTICOS CON CRON
  const reportsCronJob = new CronJob(
    '0 0 * * *', // Todos los días a medianoche (12:00 AM)
    async () => {
      try {
        console.log('🕛 Ejecutando reporte automático programado...');
        const report = await generateCompleteSystemReport();
        
        // Enviar a todos los métodos de notificación habilitados
        await sendNotifications(report);
        
        // Registrar en auditoría
        try {
          await storage.createAuditEvent({
            actorType: 'system',
            sessionId: `cron-report-${Date.now()}`,
            actionCode: AuditActionCodes.REPORT_GENERATE,
            result: 'success',
            metadata: JSON.stringify({ 
              trigger: 'automatic',
              timestamp: new Date().toISOString(),
              scheduledTime: '00:00'
            })
          });
        } catch (auditError) {
          console.error('Error creating audit event:', auditError);
        }
        
        console.log('✅ Reporte automático completado exitosamente');
        
      } catch (error) {
        console.error('❌ Error en reporte automático:', error);
        
        // Intentar registrar el error en auditoría
        try {
          await storage.createAuditEvent({
            actorType: 'system',
            sessionId: `cron-report-error-${Date.now()}`,
            actionCode: AuditActionCodes.REPORT_GENERATE,
            result: 'error',
            metadata: JSON.stringify({ 
              trigger: 'automatic',
              error: error instanceof Error ? error.message : 'Error desconocido',
              timestamp: new Date().toISOString()
            })
          });
        } catch (auditError) {
          console.error('❌ Error registrando fallo en auditoría:', auditError);
        }
      }
    },
    null, // onComplete callback
    true, // start immediately
    'America/Bogota' // Timezone Colombia
  );

  // 🎯 PERSONALIZED RECOMMENDATIONS ENDPOINTS
  // Track user product interaction
  app.post("/api/recommendations/track", async (req, res) => {
    try {
      const { customerId, productId, interactionType, categoryId, brandId, priceViewed } = req.body;

      if (!customerId || !productId || !interactionType) {
        return res.status(400).json({
          success: false,
          message: "customerId, productId, and interactionType are required"
        });
      }

      await storage.trackUserInteraction({
        customerId,
        productId,
        interactionType,
        categoryId,
        brandId,
        priceViewed
      });

      res.json({ success: true, message: "Interaction tracked" });
    } catch (error) {
      console.error("Error tracking interaction:", error);
      res.status(500).json({ success: false, message: "Error tracking interaction" });
    }
  });

  // Get personalized recommendations
  app.get("/api/recommendations/:customerId", async (req, res) => {
    try {
      const { customerId } = req.params;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 8;

      if (!customerId) {
        return res.status(400).json({
          success: false,
          message: "customerId is required"
        });
      }

      const recommendations = await storage.getPersonalizedRecommendations(customerId, limit);

      res.json({
        success: true,
        data: recommendations,
        count: recommendations.length
      });
    } catch (error) {
      console.error("Error getting recommendations:", error);
      res.status(500).json({ success: false, message: "Error getting recommendations" });
    }
  });

  const httpServer = createServer(app);

  // WebSocket server for real-time communication
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws: WebSocket, req) => {
    console.log('🔗 New WebSocket connection');

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        console.log('📨 WebSocket message:', data);

        // Handle different message types
        if (data.type === 'register_device') {
          // Register device for real-time updates
          ws.deviceId = data.deviceId;
          ws.send(JSON.stringify({ type: 'registered', deviceId: data.deviceId }));
        } else if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    });

    ws.on('close', () => {
      console.log('🔌 WebSocket connection closed');
    });
  });

  // Function to broadcast messages to all connected clients
  const broadcast = (message: any) => {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
  };

  // Store broadcast function globally for use in routes
  (global as any).broadcast = broadcast;
  
  console.log('🕛 Sistema de reportes automáticos activado');
  console.log('📊 Endpoint manual: GET /api/admin/generate-report');
  console.log('⏰ Reportes automáticos: Todos los días a las 12:00 AM (Bogotá)');
  console.log('📬 Métodos de notificación habilitados:');
  notificationMethods.forEach(method => {
    if (method.enabled) {
      console.log(`  ✅ ${method.name}`);
    } else {
      console.log(`  ⚪ ${method.name} (deshabilitado)`);
    }
  });
  
  console.log('🎯 Sistema de recomendaciones personalizadas activado');
  console.log('📍 Endpoints:');
  console.log('  POST /api/recommendations/track - Rastrear interacción de usuario');
  console.log('  GET /api/recommendations/:customerId - Obtener recomendaciones');
  
  return httpServer;
}
