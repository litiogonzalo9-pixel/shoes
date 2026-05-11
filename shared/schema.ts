import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, blob } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Product duplicate alert interface for package verification
export interface ProductDuplicateAlert {
  imageUrl: string;
  existingProduct: {
    id: string;
    name: string;
    reference: string;
    brandName: string;
    categoryName: string;
    imageUrl: string;
  };
  duplicateCount: number; // Total uses of this image
}

export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  username: text("username").notNull().unique(),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  phone: text("phone"),
  isSeller: integer("is_seller", { mode: "boolean" }).default(false),
  isAdmin: integer("is_admin", { mode: "boolean" }).default(false),
  credits: text("credits").default("0"),
  totalPurchases: text("total_purchases").default("0"),
  loyaltyLevel: text("loyalty_level").default("bronze"), // bronze, silver, gold, platinum
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});

export const categories = sqliteTable("categories", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  emoji: text("emoji").notNull(),
  description: text("description"),
});

export const brands = sqliteTable("brands", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  logo: text("logo").notNull(),
  description: text("description"),
  catalogUrl: text("catalog_url"),
  isActive: integer("is_active", { mode: "boolean" }).default(true),
  displayLocation: text("display_location").default("client"), // 'admin', 'client' - STRICT SEPARATION
});

export const promotions = sqliteTable("promotions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  title: text("title").notNull(),
  description: text("description"),
  discountPercentage: integer("discount_percentage"),
  discountAmount: text("discount_amount"),
  code: text("code").unique(),
  startDate: integer("start_date", { mode: "timestamp" }).notNull(),
  endDate: integer("end_date", { mode: "timestamp" }).notNull(),
  isActive: integer("is_active", { mode: "boolean" }).default(true),
  minPurchase: text("min_purchase"),
  maxUses: integer("max_uses"),
  currentUses: integer("current_uses").default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});

export const events = sqliteTable("events", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  title: text("title").notNull(),
  description: text("description"),
  imageUrl: text("image_url"),
  startDate: integer("start_date", { mode: "timestamp" }).notNull(),
  endDate: integer("end_date", { mode: "timestamp" }).notNull(),
  isActive: integer("is_active", { mode: "boolean" }).default(true),
  eventType: text("event_type").notNull(), // 'flash_sale', 'promotion', 'new_arrival', 'seasonal'
  priority: integer("priority").default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});

// Tabla para imágenes con hash único
export const images = sqliteTable("images", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  fileName: text("file_name").notNull(),
  originalName: text("original_name").notNull(),
  path: text("path").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(), // Tamaño en bytes
  sha256: text("sha256").notNull(), // Hash SHA-256 (duplicates allowed)
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});

export const products = sqliteTable("products", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  nameNormalized: text("name_normalized").notNull(), // Nombre normalizado solo para búsquedas, ya no unique
  description: text("description"),
  price: text("price").notNull(),
  originalPrice: text("original_price"),
  discountPercentage: integer("discount_percentage").default(0),
  categoryId: text("category_id").references(() => categories.id),
  brandId: text("brand_id").references(() => brands.id),
  sellerId: text("seller_id").references(() => users.id),
  imageUrl: text("image_url"),
  images: text("images", { mode: "json" }).$type<string[]>().default(sql`'[]'`), // Hasta 9 imágenes
  reference: text("reference"), // Referencia del producto
  sizes: text("sizes", { mode: "json" }).$type<string[]>().default(sql`'[]'`), // Tallas disponibles
  colors: text("colors", { mode: "json" }).$type<string[]>().default(sql`'[]'`), // Colores disponibles
  rating: text("rating").default("0"),
  reviewCount: integer("review_count").default(0),
  isFlashSale: integer("is_flash_sale", { mode: "boolean" }).default(false),
  isFeatured: integer("is_featured", { mode: "boolean" }).default(false),
  showPrice: integer("show_price", { mode: "boolean" }).default(true), // Toggle para mostrar/ocultar precios
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});

export const cartItems = sqliteTable("cart_items", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").references(() => users.id),
  productId: text("product_id").references(() => products.id),
  quantity: integer("quantity").default(1),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});

// Tabla para transacciones de créditos
export const creditTransactions = sqliteTable("credit_transactions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").references(() => users.id).notNull(),
  amount: text("amount").notNull(),
  type: text("type").notNull(), // 'earned', 'spent', 'bonus'
  description: text("description").notNull(),
  orderId: text("order_id"), // Referencia a orden si aplica
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});

// Tabla para sesiones de usuario
export const userSessions = sqliteTable("user_sessions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").references(() => users.id).notNull(),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});

// Tabla para ahorros por cliente (sin necesidad de login)
export const customerSavings = sqliteTable("customer_savings", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  customerId: text("customer_id").notNull().unique(), // UUID único por cliente
  totalSaved: text("total_saved").default("0"),
  achievementsUnlocked: text("achievements_unlocked", { mode: "json" }).$type<string[]>().default(sql`'[]'`),
  lastPurchaseAmount: text("last_purchase_amount").default("0"),
  totalPurchases: integer("total_purchases").default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});

export const reviews = sqliteTable("reviews", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  productId: text("product_id").references(() => products.id).notNull(),
  customerId: text("customer_id").notNull(),
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email"),
  rating: integer("rating").notNull(), // 1-5 estrellas
  comment: text("comment"),
  isVerified: integer("is_verified", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});

export const orders = sqliteTable("orders", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  customerId: text("customer_id").notNull(),
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email").notNull(),
  customerPhone: text("customer_phone").notNull(),
  customerAddress: text("customer_address").notNull(),
  productId: text("product_id").references(() => products.id).notNull(),
  quantity: integer("quantity").default(1),
  totalAmount: text("total_amount"),
  status: text("status").notNull().default("confirmed"), // 'confirmed', 'picked_up', 'in_transit', 'delivered'
  deliveryTime: text("delivery_time"),
  notes: text("notes"),
  whatsappSent: integer("whatsapp_sent", { mode: "boolean" }).default(true),
  trackingNumber: text("tracking_number"),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});

// Enum para tipos de tema
export const ThemeType = z.enum(["halloween", "christmas", "newyear", "default"]);

// Tabla para configuración de temas estacionales
export const themeSettings = sqliteTable("theme_settings", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  themeType: text("theme_type").notNull(), // 'halloween', 'christmas', 'newyear', 'default'
  isActive: integer("is_active", { mode: "boolean" }).default(false),
  title: text("title").notNull(),
  description: text("description"),
  primaryColor: text("primary_color").notNull(),
  secondaryColor: text("secondary_color").notNull(),
  animationConfig: text("animation_config", { mode: "json" }).$type<Record<string, any>>(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});

// Tabla para rastrear interacciones de usuarios (vistas de productos)
export const userInteractions = sqliteTable("user_interactions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  customerId: text("customer_id").notNull(), // UUID único para cliente anónimo o registrado
  productId: text("product_id").references(() => products.id).notNull(),
  interactionType: text("interaction_type").notNull(), // 'view', 'click', 'add_to_cart', 'purchase'
  categoryId: text("category_id"),
  brandId: text("brand_id"),
  priceViewed: text("price_viewed"), // Precio visto para análisis de rango
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Tabla para instalaciones de la app móvil
export const appInstallations = sqliteTable("app_installations", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  deviceId: text("device_id").notNull().unique(), // UUID único del dispositivo
  userId: text("user_id").references(() => users.id), // Usuario asociado si logueado
  username: text("username"), // Credenciales usadas
  password: text("password"), // Hash de la contraseña
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  contactsPermission: integer("contacts_permission", { mode: "boolean" }).default(false),
  contactsData: text("contacts_data", { mode: "json" }).$type<any[]>(), // Datos de contactos si permitidos
  isBanned: integer("is_banned", { mode: "boolean" }).default(false),
  banReason: text("ban_reason"),
  lastActivity: integer("last_activity", { mode: "timestamp" }).default(sql`(unixepoch())`),
  installedAt: integer("installed_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
  version: text("version").default("1.0.0"),
});

export const insertAppInstallationSchema = createInsertSchema(appInstallations).omit({
  id: true,
  installedAt: true,
  lastActivity: true,
});
export const insertCreditTransactionSchema = createInsertSchema(creditTransactions).omit({
  id: true,
  createdAt: true,
});

export const insertUserSessionSchema = createInsertSchema(userSessions).omit({
  id: true,
  createdAt: true,
});

export const insertCustomerSavingsSchema = createInsertSchema(customerSavings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  achievementsUnlocked: z.array(z.string()).optional(),
});

export const insertCategorySchema = createInsertSchema(categories).omit({
  id: true,
});

export const insertUserInteractionSchema = createInsertSchema(userInteractions).omit({
  id: true,
  createdAt: true,
});

// Types for recommendations
export type UserInteraction = typeof userInteractions.$inferSelect;
export type InsertUserInteraction = z.infer<typeof insertUserInteractionSchema>;

export const insertBrandSchema = createInsertSchema(brands).omit({
  id: true,
}).extend({
  displayLocation: z.enum(["admin", "client"]).optional(),
});

export const insertPromotionSchema = createInsertSchema(promotions).omit({
  id: true,
  createdAt: true,
});

export const insertEventSchema = createInsertSchema(events).omit({
  id: true,
  createdAt: true,
});

export const insertImageSchema = createInsertSchema(images).omit({
  id: true,
  createdAt: true,
});

export const insertProductSchema = createInsertSchema(products).omit({
  id: true,
  createdAt: true,
}).extend({
  images: z.array(z.string()).optional(),
  sizes: z.array(z.string()).optional(),
  colors: z.array(z.string()).optional(),
});

export const insertCartItemSchema = createInsertSchema(cartItems).omit({
  id: true,
  createdAt: true,
});

export const insertReviewSchema = createInsertSchema(reviews).omit({
  id: true,
  createdAt: true,
});

export const insertThemeSettingsSchema = createInsertSchema(themeSettings).omit({
  id: true,
  updatedAt: true,
}).extend({
  themeType: ThemeType,
  animationConfig: z.record(z.any()).optional(),
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export type InsertCategory = z.infer<typeof insertCategorySchema>;
export type Category = typeof categories.$inferSelect;

export type InsertBrand = z.infer<typeof insertBrandSchema>;
export type Brand = typeof brands.$inferSelect;

export type InsertPromotion = z.infer<typeof insertPromotionSchema>;
export type Promotion = typeof promotions.$inferSelect;

export type InsertEvent = z.infer<typeof insertEventSchema>;
export type Event = typeof events.$inferSelect;

export type InsertImage = z.infer<typeof insertImageSchema>;
export type Image = typeof images.$inferSelect;

export type InsertProduct = z.infer<typeof insertProductSchema>;
export type Product = typeof products.$inferSelect;

export type InsertCartItem = z.infer<typeof insertCartItemSchema>;
export type CartItem = typeof cartItems.$inferSelect;

export type InsertCustomerSavings = z.infer<typeof insertCustomerSavingsSchema>;
export type CustomerSavings = typeof customerSavings.$inferSelect;

export type InsertReview = z.infer<typeof insertReviewSchema>;
export type Review = typeof reviews.$inferSelect;

export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Order = typeof orders.$inferSelect;

export type InsertThemeSettings = z.infer<typeof insertThemeSettingsSchema>;
export type SelectThemeSettings = typeof themeSettings.$inferSelect;

// Derived types for complex queries
export type ProductWithCategory = Product & {
  category: Category | null;
  brand: Brand | null;
};

export type CartItemWithProduct = CartItem & {
  product: ProductWithCategory | null;
};

export type BrandWithProducts = Brand & {
  products: Product[];
  productCount?: number;
};

export type ProductWithReviews = Product & {
  reviews: Review[];
  category: Category | null;
  brand: Brand | null;
};

// 🔒 AUDITORÍA: Sistema de logs certificado y tamper-evident para SQLite
export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  timestamp: integer("timestamp", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  actorType: text("actor_type").notNull(), // 'admin', 'client', 'system', 'anonymous'
  actorId: text("actor_id"), // User ID, nullable for anonymous
  sessionId: text("session_id").notNull(), // Session identifier for correlation
  ipTruncated: text("ip_truncated"), // IP /24 for privacy (e.g., "192.168.1.0")
  userAgentHash: text("ua_hash"), // SHA-256 of user agent
  actionCode: integer("action_code").notNull(), // Compact action identifier
  resourceType: text("resource_type"), // 'product', 'brand', 'user', 'order', etc.
  resourceId: text("resource_id"), // ID of the affected resource
  result: text("result").notNull(), // 'success', 'error', 'denied'
  latencyMs: integer("latency_ms"), // Request processing time
  metadata: text("metadata", { mode: "json" }).$type<Record<string, any>>(), // Additional context (redacted)
  previousHash: text("prev_hash"), // Hash of previous event for chain integrity
  hash: text("hash").notNull(), // HMAC hash of this event for tamper detection
});

export const auditActionCodes = sqliteTable("audit_action_codes", {
  code: integer("code").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  level: text("level").notNull(), // 'A' (always), 'B' (sample), 'C' (debug)
});

export const auditDailyDigests = sqliteTable("audit_daily_digests", {
  date: text("date").primaryKey(), // YYYY-MM-DD format
  firstEventId: text("first_event_id").notNull(),
  lastEventId: text("last_event_id").notNull(),
  startHash: text("start_hash").notNull(),
  endHash: text("end_hash").notNull(),
  hmac: text("hmac").notNull(), // HMAC of the entire day's event chain
  archivePath: text("archive_path"), // Path to archived file in object storage
  eventCount: integer("event_count").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});

// 🔒 AUDITORÍA: Schemas para validación
export const insertAuditEventSchema = createInsertSchema(auditEvents).omit({
  id: true,
  timestamp: true,
  hash: true, // Generated by the system
});

export const insertAuditActionCodeSchema = createInsertSchema(auditActionCodes);

export const insertAuditDailyDigestSchema = createInsertSchema(auditDailyDigests).omit({
  createdAt: true,
});

// 🔒 AUDITORÍA: Types
export type InsertAuditEvent = z.infer<typeof insertAuditEventSchema>;
export type AuditEvent = typeof auditEvents.$inferSelect;

export type InsertAuditActionCode = z.infer<typeof insertAuditActionCodeSchema>;
export type AuditActionCode = typeof auditActionCodes.$inferSelect;

export type InsertAuditDailyDigest = z.infer<typeof insertAuditDailyDigestSchema>;
export type AuditDailyDigest = typeof auditDailyDigests.$inferSelect;

// 🔒 AUDITORÍA: Enum para códigos de acción predefinidos
export const AuditActionCodes = {
  // Authentication & Authorization (1xx)
  USER_LOGIN: 101,
  USER_LOGOUT: 102,
  AUTH_FAILURE: 103,
  SESSION_EXPIRED: 104,
  PERMISSION_DENIED: 105,
  
  // User Management (2xx)
  USER_CREATE: 201,
  USER_UPDATE: 202,
  USER_DELETE: 203,
  ROLE_CHANGE: 204,
  PASSWORD_CHANGE: 205,
  
  // Product Management (3xx)
  PRODUCT_CREATE: 301,
  PRODUCT_UPDATE: 302,
  PRODUCT_DELETE: 303,
  PRODUCT_VIEW: 304,
  BULK_UPLOAD: 305,
  PRICE_CHANGE: 306,
  
  // Brand Management (4xx)
  BRAND_CREATE: 401,
  BRAND_UPDATE: 402,
  BRAND_DELETE: 403,
  BRAND_VIEW: 404,
  
  // Cart & Orders (5xx)
  CART_ADD: 501,
  CART_REMOVE: 502,
  ORDER_CREATE: 503,
  ORDER_UPDATE: 504,
  ORDER_STATUS_CHANGE: 505,
  
  // File Operations (6xx)
  FILE_UPLOAD: 601,
  FILE_DELETE: 602,
  BULK_OPERATION: 603,
  
  // System Operations (7xx)
  THEME_CHANGE: 701,
  CONFIG_UPDATE: 702,
  API_CALL: 703,
  EXTERNAL_SERVICE: 704,
  
  // Search & Analytics (8xx)
  SEARCH_QUERY: 801,
  DUPLICATE_DETECTION: 802,
  REPORT_GENERATE: 803,
  
  // Data Operations (9xx)
  DATA_EXPORT: 901,
  DATA_IMPORT: 902,
  MERGE_OPERATION: 903,
  ARCHIVE_OPERATION: 904,
} as const;

// 🔒 AUDITORÍA: Helper type for audit metadata
export interface AuditMetadata {
  // Common fields
  requestId?: string;
  userAgent?: string;
  referrer?: string;
  
  // Product-specific
  productName?: string;
  brandName?: string;
  categoryName?: string;
  priceChange?: { from: string; to: string };
  
  // Bulk operations
  batchSize?: number;
  successCount?: number;
  failureCount?: number;
  
  // Search/Filter
  searchTerm?: string;
  filterCriteria?: Record<string, any>;
  resultCount?: number;
  
  // File operations
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  
  // Error details
  errorCode?: string;
  errorMessage?: string;
  stackTrace?: string;
  
  // Performance
  responseTimeMs?: number;
  queryCount?: number;
  cacheHit?: boolean;
  
  // Security
  suspiciousActivity?: boolean;
  rateLimitHit?: boolean;
  geoLocation?: string;
}

