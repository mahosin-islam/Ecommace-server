import { Router } from 'express';
import { healthRouter } from '../services/health.js';
import { authRouter } from '../services/auth.js';
import { usersRouter } from '../services/users.js';
import { productRouter } from '../services/products.js';
import { categoryRouter } from '../services/categories.js';
import { cartRouter } from '../services/cart.js';
import { orderRouter } from '../services/orders.js';
import { settingRouter } from '../services/settings.js';

export const router = Router();

router.use('/health', healthRouter);
router.use('/auth', authRouter);
router.use('/users', usersRouter);
router.use('/products', productRouter);
router.use('/categories', categoryRouter);
router.use('/cart', cartRouter);
router.use('/orders', orderRouter);
router.use('/settings', settingRouter);
