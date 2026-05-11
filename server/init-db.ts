import { db, sqlite } from './db';
import { users, categories, brands, themeSettings, auditActionCodes } from '@shared/schema';
import { eq, sql } from 'drizzle-orm';
import crypto from 'crypto';

export async function initializeDatabase() {
  try {
    console.log('🗄️ Initializing SQLite database...');

    // Create tables using manual SQL to ensure they exist
    // This prevents errors if tables don't exist yet
    const createTablesSQL = `
      CREATE TABLE IF NOT EXISTS "categories" (
        "id" text PRIMARY KEY NOT NULL,
        "name" text NOT NULL,
        "emoji" text NOT NULL,
        "description" text
      );

      CREATE TABLE IF NOT EXISTS "brands" (
        "id" text PRIMARY KEY NOT NULL,
        "name" text NOT NULL,
        "logo" text NOT NULL,
        "description" text,
        "catalog_url" text,
        "is_active" integer DEFAULT 1,
        "display_location" text DEFAULT 'client'
      );

      CREATE TABLE IF NOT EXISTS "users" (
        "id" text PRIMARY KEY NOT NULL,
        "username" text NOT NULL UNIQUE,
        "email" text NOT NULL UNIQUE,
        "password" text NOT NULL,
        "first_name" text,
        "last_name" text,
        "phone" text,
        "is_seller" integer DEFAULT 0,
        "is_admin" integer DEFAULT 0,
        "credits" text DEFAULT '0',
        "total_purchases" text DEFAULT '0',
        "loyalty_level" text DEFAULT 'bronze',
        "created_at" integer DEFAULT (unixepoch()),
        "updated_at" integer DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS "products" (
        "id" text PRIMARY KEY NOT NULL,
        "name" text NOT NULL,
        "name_normalized" text NOT NULL,
        "description" text,
        "price" text NOT NULL,
        "original_price" text,
        "discount_percentage" integer DEFAULT 0,
        "category_id" text,
        "brand_id" text,
        "seller_id" text,
        "image_url" text,
        "images" text DEFAULT '[]',
        "reference" text,
        "sizes" text DEFAULT '[]',
        "colors" text DEFAULT '[]',
        "rating" text DEFAULT '0',
        "review_count" integer DEFAULT 0,
        "is_flash_sale" integer DEFAULT 0,
        "is_featured" integer DEFAULT 0,
        "created_at" integer DEFAULT (unixepoch()),
        FOREIGN KEY ("category_id") REFERENCES "categories" ("id"),
        FOREIGN KEY ("brand_id") REFERENCES "brands" ("id"),
        FOREIGN KEY ("seller_id") REFERENCES "users" ("id")
      );

      CREATE TABLE IF NOT EXISTS "customer_savings" (
        "id" text PRIMARY KEY NOT NULL,
        "customer_id" text NOT NULL UNIQUE,
        "total_saved" text DEFAULT '0',
        "achievements_unlocked" text DEFAULT '[]',
        "last_purchase_amount" text DEFAULT '0',
        "total_purchases" integer DEFAULT 0,
        "created_at" integer DEFAULT (unixepoch()),
        "updated_at" integer DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS "images" (
        "id" text PRIMARY KEY NOT NULL,
        "file_name" text NOT NULL,
        "original_name" text NOT NULL,
        "path" text NOT NULL,
        "mime_type" text NOT NULL,
        "size" integer NOT NULL,
        "sha256" text NOT NULL,
        "created_at" integer DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS "reviews" (
        "id" text PRIMARY KEY NOT NULL,
        "product_id" text NOT NULL,
        "customer_id" text NOT NULL,
        "customer_name" text NOT NULL,
        "customer_email" text,
        "rating" integer NOT NULL,
        "comment" text,
        "is_verified" integer DEFAULT 0,
        "created_at" integer DEFAULT (unixepoch()),
        FOREIGN KEY ("product_id") REFERENCES "products" ("id")
      );

      CREATE TABLE IF NOT EXISTS "orders" (
        "id" text PRIMARY KEY NOT NULL,
        "customer_id" text NOT NULL,
        "customer_name" text NOT NULL,
        "customer_email" text NOT NULL,
        "customer_phone" text NOT NULL,
        "customer_address" text NOT NULL,
        "product_id" text NOT NULL,
        "quantity" integer DEFAULT 1,
        "total_amount" text,
        "status" text NOT NULL DEFAULT 'confirmed',
        "delivery_time" text,
        "notes" text,
        "whatsapp_sent" integer DEFAULT 1,
        "tracking_number" text,
        "created_at" integer DEFAULT (unixepoch()),
        "updated_at" integer DEFAULT (unixepoch()),
        FOREIGN KEY ("product_id") REFERENCES "products" ("id")
      );

      CREATE TABLE IF NOT EXISTS "app_installations" (
        "id" text PRIMARY KEY NOT NULL,
        "device_id" text NOT NULL UNIQUE,
        "user_id" text,
        "username" text,
        "password" text,
        "ip_address" text,
        "user_agent" text,
        "contacts_permission" integer DEFAULT 0,
        "contacts_data" text DEFAULT '[]',
        "is_banned" integer DEFAULT 0,
        "ban_reason" text,
        "last_activity" integer DEFAULT (unixepoch()),
        "installed_at" integer DEFAULT (unixepoch()),
        "version" text DEFAULT '1.0.0'
      );

      CREATE TABLE IF NOT EXISTS "promotions" (
        "id" text PRIMARY KEY NOT NULL,
        "title" text NOT NULL,
        "description" text,
        "discount_percentage" integer,
        "discount_amount" text,
        "code" text UNIQUE,
        "start_date" integer NOT NULL,
        "end_date" integer NOT NULL,
        "is_active" integer DEFAULT 1,
        "min_purchase" text,
        "max_uses" integer,
        "current_uses" integer DEFAULT 0,
        "created_at" integer DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS "events" (
        "id" text PRIMARY KEY NOT NULL,
        "title" text NOT NULL,
        "description" text,
        "image_url" text,
        "start_date" integer NOT NULL,
        "end_date" integer NOT NULL,
        "is_active" integer DEFAULT 1,
        "event_type" text NOT NULL,
        "priority" integer DEFAULT 0,
        "created_at" integer DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS "cart_items" (
        "id" text PRIMARY KEY NOT NULL,
        "user_id" text,
        "product_id" text,
        "quantity" integer DEFAULT 1,
        "created_at" integer DEFAULT (unixepoch()),
        FOREIGN KEY ("user_id") REFERENCES "users" ("id"),
        FOREIGN KEY ("product_id") REFERENCES "products" ("id")
      );

      CREATE TABLE IF NOT EXISTS "theme_settings" (
        "id" text PRIMARY KEY NOT NULL,
        "theme_type" text NOT NULL,
        "is_active" integer DEFAULT 0,
        "title" text NOT NULL,
        "description" text,
        "primary_color" text NOT NULL,
        "secondary_color" text NOT NULL,
        "animation_config" text,
        "updated_at" integer DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS "audit_events" (
        "id" text PRIMARY KEY NOT NULL,
        "timestamp" integer NOT NULL DEFAULT (unixepoch()),
        "actor_type" text NOT NULL,
        "actor_id" text,
        "session_id" text NOT NULL,
        "ip_truncated" text,
        "ua_hash" text,
        "action_code" integer NOT NULL,
        "resource_type" text,
        "resource_id" text,
        "result" text NOT NULL,
        "latency_ms" integer,
        "metadata" text,
        "prev_hash" text,
        "hash" text NOT NULL
      );

      CREATE TABLE IF NOT EXISTS "audit_action_codes" (
        "code" integer PRIMARY KEY NOT NULL,
        "name" text NOT NULL UNIQUE,
        "description" text,
        "level" text NOT NULL
      );

      CREATE TABLE IF NOT EXISTS "audit_daily_digests" (
        "date" text PRIMARY KEY NOT NULL,
        "first_event_id" text NOT NULL,
        "last_event_id" text NOT NULL,
        "start_hash" text NOT NULL,
        "end_hash" text NOT NULL,
        "hmac" text NOT NULL,
        "archive_path" text,
        "event_count" integer NOT NULL DEFAULT 0,
        "created_at" integer DEFAULT (unixepoch())
      );
    `;

    // Execute table creation SQL
    sqlite.exec(createTablesSQL);
    console.log('✅ SQLite tables created/verified');

    // Insert default categories only if they don't exist
    const defaultCategories = [
      { name: "Tacones", emoji: "👠", description: "Elegantes tacones para toda ocasión" },
      { name: "Deportivos", emoji: "👟", description: "Zapatos deportivos y cómodos" },
      { name: "Botas", emoji: "👢", description: "Botas para todas las temporadas" },
      { name: "Sandalias", emoji: "🩴", description: "Sandalias frescas y cómodas" },
      { name: "Casuales", emoji: "🥿", description: "Zapatos casuales para el día a día" },
      { name: "Formales", emoji: "👞", description: "Zapatos formales y elegantes" },
    ];

    for (const cat of defaultCategories) {
      try {
        const existing = await db.select().from(categories).where(eq(categories.name, cat.name)).limit(1);
        if (existing.length === 0) {
          await db.insert(categories).values({
            id: crypto.randomUUID(),
            ...cat
          });
          console.log(`✅ Inserted category: ${cat.name}`);
        }
      } catch (error) {
        console.log(`Category ${cat.name} might already exist:`, error);
      }
    }

    // Insert default brands
    const defaultBrands = [
      { name: "Nike", logo: "https://logos-world.net/wp-content/uploads/2020/04/Nike-Logo.png", description: "Just Do It - Marca líder en deportivos", catalogUrl: "https://nike.com/catalog", displayLocation: "admin" },
      { name: "Adidas", logo: "https://logos-world.net/wp-content/uploads/2020/04/Adidas-Logo.png", description: "Impossible is Nothing - Deportivos de alta calidad", catalogUrl: "https://adidas.com/catalog", displayLocation: "admin" },
      { name: "Asics", logo: "https://logos-world.net/wp-content/uploads/2020/04/ASICS-Logo.png", description: "Sound Mind, Sound Body - Tecnología japonesa", catalogUrl: "https://asics.com/catalog", displayLocation: "admin" },
      { name: "REVISIÓN PENDIENTE", logo: "https://via.placeholder.com/100x50/ff9900/ffffff?text=REVIEW", description: "Productos que requieren revisión manual de marca", catalogUrl: null, displayLocation: "admin" },
      { name: "CATÁLOGO COMPLETO", logo: "https://via.placeholder.com/100x50/007acc/ffffff?text=CATALOGO", description: "Todos los productos disponibles en nuestra tienda", catalogUrl: null, displayLocation: "admin" },
      { name: "EUROPEO", logo: "https://via.placeholder.com/100x50/2d5a27/ffffff?text=EUROPEO", description: "Calzado de estilo europeo elegante y sofisticado", catalogUrl: null, displayLocation: "admin" },
      { name: "GUALLOS", logo: "https://via.placeholder.com/100x50/8b4513/ffffff?text=GUALLOS", description: "Zapatos de cuero artesanal de alta calidad", catalogUrl: null, displayLocation: "admin" },
    ];

    for (const brand of defaultBrands) {
      try {
        const existing = await db.select().from(brands).where(eq(brands.name, brand.name)).limit(1);
        if (existing.length === 0) {
          await db.insert(brands).values({
            id: crypto.randomUUID(),
            name: brand.name,
            logo: brand.logo,
            description: brand.description,
            catalogUrl: brand.catalogUrl,
            isActive: true,
            displayLocation: brand.displayLocation as "admin" | "client"
          });
          console.log(`✅ Inserted brand: ${brand.name}`);
        }
      } catch (error) {
        console.log(`Brand ${brand.name} might already exist:`, error);
      }
    }

    // 🔒 CRITICAL SECURITY FIX: Migrate existing brands from 'client' to 'admin' displayLocation
    // This ensures admin has COMPLETE control over which brands clients can see
    try {
      const brandsToMigrate = await db.select().from(brands).where(eq(brands.displayLocation, 'client'));
      if (brandsToMigrate.length > 0) {
        console.log(`🔧 Migrating ${brandsToMigrate.length} brands from 'client' to 'admin' display location...`);
        
        for (const brand of brandsToMigrate) {
          await db.update(brands)
            .set({ displayLocation: 'admin' })
            .where(eq(brands.id, brand.id));
          console.log(`✅ Migrated brand "${brand.name}" to admin control`);
        }
        
        console.log('🔒 Brand migration complete: Admin now has FULL control over all brand visibility');
      } else {
        console.log('✅ No brand migration needed: All brands already under admin control');
      }
    } catch (error) {
      console.error('❌ Error migrating brands to admin control:', error);
    }

    // Insert default admin user and emulator admin user
    try {
      const existingAdmin = await db.select().from(users).where(eq(users.username, 'admin')).limit(1);
      if (existingAdmin.length === 0) {
        await db.insert(users).values({
          id: crypto.randomUUID(),
          username: 'admin',
          email: 'admin@zapashop.com',
          password: 'admin123',
          firstName: 'Administrador',
          lastName: 'ZapaShop',
          isAdmin: true
        });
        console.log('✅ Inserted admin user');
      }

      const existingEmulator = await db.select().from(users).where(eq(users.username, '108383')).limit(1);
      if (existingEmulator.length === 0) {
        await db.insert(users).values({
          id: crypto.randomUUID(),
          username: '108383',
          email: 'emulator@zapashop.com',
          password: '108383',
          firstName: 'Emulador',
          lastName: 'Auditor',
          isAdmin: true
        });
        console.log('✅ Inserted emulator admin user');
      }
    } catch (error) {
      console.log('Admin user might already exist:', error);
    }

    // Insert default theme settings
    const defaultThemes = [
      {
        themeType: 'halloween',
        isActive: false,
        title: '🎃 Halloween',
        description: 'Tema oscuro y misterioso para Halloween',
        primaryColor: '#ff6600',
        secondaryColor: '#000000',
        animationConfig: JSON.stringify({ 
          enablePumpkins: true, 
          ghostEffects: true,
          spookyTransitions: true 
        })
      },
      {
        themeType: 'christmas',
        isActive: false,
        title: '🎄 Navidad',
        description: 'Tema festivo navideño con colores tradicionales',
        primaryColor: '#dc2626',
        secondaryColor: '#16a34a',
        animationConfig: JSON.stringify({ 
          snowfall: true, 
          sparkles: true,
          festiveLights: true 
        })
      },
      {
        themeType: 'newyear',
        isActive: false,
        title: '🎆 Año Nuevo',
        description: 'Tema elegante para celebrar el año nuevo',
        primaryColor: '#fbbf24',
        secondaryColor: '#6b7280',
        animationConfig: JSON.stringify({ 
          fireworks: true, 
          goldSparkles: true,
          countdownEffects: true 
        })
      },
      {
        themeType: 'default',
        isActive: true, // Solo el tema por defecto estará activo inicialmente
        title: '🏪 Tema Original',
        description: 'Tema original de la tienda con colores corporativos',
        primaryColor: '#3b82f6',
        secondaryColor: '#1f2937',
        animationConfig: JSON.stringify({ 
          subtleAnimations: true, 
          modernTransitions: true 
        })
      }
    ];

    for (const theme of defaultThemes) {
      try {
        const existing = await db.select().from(themeSettings)
          .where(eq(themeSettings.themeType, theme.themeType))
          .limit(1);
        
        if (existing.length === 0) {
          await db.insert(themeSettings).values(theme);
          console.log(`✅ Inserted theme: ${theme.title}`);
        }
      } catch (error) {
        console.log(`Theme ${theme.title} might already exist:`, error);
      }
    }

    // Insert default audit action codes
    const defaultActionCodes = [
      // Authentication & Authorization (1xx)
      { code: 101, name: 'USER_LOGIN', description: 'Usuario inició sesión', level: 'A' },
      { code: 102, name: 'USER_LOGOUT', description: 'Usuario cerró sesión', level: 'A' },
      { code: 103, name: 'AUTH_FAILURE', description: 'Fallo en autenticación', level: 'A' },
      { code: 104, name: 'SESSION_EXPIRED', description: 'Sesión expirada', level: 'A' },
      { code: 105, name: 'PERMISSION_DENIED', description: 'Acceso denegado', level: 'A' },
      
      // User Management (2xx)
      { code: 201, name: 'USER_CREATE', description: 'Usuario creado', level: 'A' },
      { code: 202, name: 'USER_UPDATE', description: 'Usuario actualizado', level: 'A' },
      { code: 203, name: 'USER_DELETE', description: 'Usuario eliminado', level: 'A' },
      { code: 204, name: 'ROLE_CHANGE', description: 'Cambio de rol de usuario', level: 'A' },
      { code: 205, name: 'PASSWORD_CHANGE', description: 'Cambio de contraseña', level: 'A' },
      
      // Product Management (3xx)
      { code: 301, name: 'PRODUCT_CREATE', description: 'Producto creado', level: 'A' },
      { code: 302, name: 'PRODUCT_UPDATE', description: 'Producto actualizado', level: 'A' },
      { code: 303, name: 'PRODUCT_DELETE', description: 'Producto eliminado', level: 'A' },
      { code: 304, name: 'PRODUCT_VIEW', description: 'Producto visualizado', level: 'B' },
      { code: 305, name: 'BULK_UPLOAD', description: 'Carga masiva de productos', level: 'A' },
      { code: 306, name: 'PRICE_CHANGE', description: 'Cambio de precio', level: 'A' },
      
      // Brand Management (4xx)
      { code: 401, name: 'BRAND_CREATE', description: 'Marca creada', level: 'A' },
      { code: 402, name: 'BRAND_UPDATE', description: 'Marca actualizada', level: 'A' },
      { code: 403, name: 'BRAND_DELETE', description: 'Marca eliminada', level: 'A' },
      { code: 404, name: 'BRAND_VIEW', description: 'Marca visualizada', level: 'B' },
      
      // Cart & Orders (5xx)
      { code: 501, name: 'CART_ADD', description: 'Producto agregado al carrito', level: 'B' },
      { code: 502, name: 'CART_REMOVE', description: 'Producto removido del carrito', level: 'B' },
      { code: 503, name: 'ORDER_CREATE', description: 'Pedido creado', level: 'A' },
      { code: 504, name: 'ORDER_UPDATE', description: 'Pedido actualizado', level: 'A' },
      { code: 505, name: 'ORDER_STATUS_CHANGE', description: 'Cambio de estado de pedido', level: 'A' },
      
      // File Operations (6xx)
      { code: 601, name: 'FILE_UPLOAD', description: 'Archivo subido', level: 'A' },
      { code: 602, name: 'FILE_DELETE', description: 'Archivo eliminado', level: 'A' },
      { code: 603, name: 'BULK_OPERATION', description: 'Operación masiva', level: 'A' },
      
      // System Operations (7xx)
      { code: 701, name: 'THEME_CHANGE', description: 'Cambio de tema', level: 'A' },
      { code: 702, name: 'CONFIG_UPDATE', description: 'Configuración actualizada', level: 'A' },
      { code: 703, name: 'API_CALL', description: 'Llamada a API externa', level: 'A' },
      { code: 704, name: 'EXTERNAL_SERVICE', description: 'Servicio externo utilizado', level: 'A' },
      
      // Search & Analytics (8xx)
      { code: 801, name: 'SEARCH_QUERY', description: 'Búsqueda realizada', level: 'B' },
      { code: 802, name: 'DUPLICATE_DETECTION', description: 'Detección de duplicados', level: 'A' },
      { code: 803, name: 'REPORT_GENERATE', description: 'Reporte generado', level: 'A' },
      
      // Data Operations (9xx)
      { code: 901, name: 'DATA_EXPORT', description: 'Exportación de datos', level: 'A' },
      { code: 902, name: 'DATA_IMPORT', description: 'Importación de datos', level: 'A' },
      { code: 903, name: 'MERGE_OPERATION', description: 'Operación de fusión', level: 'A' },
      { code: 904, name: 'ARCHIVE_OPERATION', description: 'Operación de archivado', level: 'A' },
    ];

    for (const actionCode of defaultActionCodes) {
      try {
        const existing = await db.select().from(auditActionCodes)
          .where(eq(auditActionCodes.code, actionCode.code))
          .limit(1);
        
        if (existing.length === 0) {
          await db.insert(auditActionCodes).values(actionCode);
          console.log(`✅ Inserted audit action code: ${actionCode.name}`);
        }
      } catch (error) {
        console.log(`Audit action code ${actionCode.name} might already exist:`, error);
      }
    }

    console.log('✅ Default data insertion complete');
    console.log('🔒 Audit system initialized with tamper-evident logging');
    console.log('🎉 SQLite database initialization complete!');

  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
}