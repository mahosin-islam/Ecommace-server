import { Router } from 'express';
import { healthRouter } from '../services/health.js';
import { authRouter } from '../services/auth.js';
import { usersRouter } from '../services/users.js';
import { productRouter } from '../services/products.js';
import { categoryRouter } from '../services/categories.js';
import { cartRouter } from '../services/cart.js';
import { couponRouter } from '../services/coupons.js';
import { orderRouter } from '../services/orders.js';
import { settingRouter } from '../services/settings.js';
import { adminDashboardRouter } from '../services/adminDashboard.js';

// Admin sub-routers
import { adminProductsRouter } from '../services/admin/adminProducts.js';
import { adminCategoriesRouter } from '../services/admin/adminCategories.js';
import { adminBrandsRouter, publicBrandsRouter } from '../services/admin/adminBrands.js';
import { adminInventoryRouter } from '../services/admin/adminInventory.js';
import { adminOrdersRouter } from '../services/admin/adminOrders.js';
import { adminCustomersRouter } from '../services/admin/adminCustomers.js';
import { adminCouponsRouter } from '../services/admin/adminCoupons.js';
import { adminReviewsRouter } from '../services/admin/adminReviews.js';
import { adminBannersRouter, publicBannersRouter } from '../services/admin/adminBanners.js';
import { adminSettingsRouter } from '../services/admin/adminSettings.js';

// Payment router
import { paymentRouter } from '../services/payment/paymentRouter.js';

export const router = Router();

// ── Public & Auth Routes ─────────────────────────────────────────────────────
router.use('/health', healthRouter);
router.use('/auth', authRouter);
router.use('/users', usersRouter);
router.use('/products', productRouter);
router.use('/categories', categoryRouter);
router.use('/cart', cartRouter);
router.use('/coupons', couponRouter);
router.use('/orders', orderRouter);
router.use('/settings', settingRouter);
router.use('/banners', publicBannersRouter);
router.use('/brands', publicBrandsRouter);

// ── Payment Routes ───────────────────────────────────────────────────────────
router.use('/payments', paymentRouter);

// ── Admin Routes ─────────────────────────────────────────────────────────────
// Dashboard (existing)
router.use('/admin', adminDashboardRouter);

// Catalog
router.use('/admin/products', adminProductsRouter);
router.use('/admin/categories', adminCategoriesRouter);
router.use('/admin/brands', adminBrandsRouter);

// Operations
router.use('/admin/inventory', adminInventoryRouter);
router.use('/admin/orders', adminOrdersRouter);
router.use('/admin/customers', adminCustomersRouter);

// Marketing & Promotions
router.use('/admin/coupons', adminCouponsRouter);
router.use('/admin/reviews', adminReviewsRouter);
router.use('/admin/banners', adminBannersRouter);

// System / Config
router.use('/admin/settings', adminSettingsRouter);
