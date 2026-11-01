import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seed...');

  // 1. Seed Store Settings
  console.log('⚙️ Seeding store settings...');
  const settings = [
    { key: 'store.name', value: 'Apex Store', type: 'string', group: 'general', description: 'Store name' },
    { key: 'store.currency', value: 'USD', type: 'string', group: 'localization', description: 'Base store currency' },
    { key: 'store.currency_symbol', value: '$', type: 'string', group: 'localization', description: 'Currency symbol' },
    { key: 'tax.rate_percent', value: '8.25', type: 'number', group: 'tax', description: 'Default sales tax rate' },
    { key: 'shipping.free_threshold', value: '75.00', type: 'number', group: 'shipping', description: 'Free shipping order threshold' },
    { key: 'shipping.flat_rate', value: '5.99', type: 'number', group: 'shipping', description: 'Standard flat rate shipping' },
    { key: 'feature.reviews_enabled', value: 'true', type: 'boolean', group: 'features', description: 'Enable customer reviews' },
    { key: 'feature.guest_checkout', value: 'true', type: 'boolean', group: 'features', description: 'Allow unauthenticated checkout' }
  ];

  for (const s of settings) {
    await prisma.storeSetting.upsert({
      where: { key: s.key },
      update: s,
      create: s
    });
  }

  // 2. Seed Default Admin User
  console.log('👤 Seeding default admin user...');
  const adminPasswordHash = await bcrypt.hash('AdminPassword123!', 10);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@ecommerce.local' },
    update: {},
    create: {
      email: 'admin@ecommerce.local',
      passwordHash: adminPasswordHash,
      firstName: 'Admin',
      lastName: 'Manager',
      role: Role.ADMIN,
      isEmailVerified: true
    }
  });

  // 3. Seed Default Customer
  console.log('👤 Seeding demo customer...');
  const customerPasswordHash = await bcrypt.hash('Customer123!', 10);
  const customer = await prisma.user.upsert({
    where: { email: 'customer@example.com' },
    update: {},
    create: {
      email: 'customer@example.com',
      passwordHash: customerPasswordHash,
      firstName: 'Jane',
      lastName: 'Shopper',
      role: Role.CUSTOMER,
      isEmailVerified: true,
      addresses: {
        create: {
          recipientName: 'Jane Shopper',
          phone: '+14155552671',
          line1: '742 Evergreen Terrace',
          city: 'Springfield',
          state: 'OR',
          postalCode: '97477',
          country: 'US',
          isDefault: true
        }
      }
    }
  });

  // 4. Seed Brands
  console.log('🏷️ Seeding brands...');
  const brandApex = await prisma.brand.upsert({
    where: { slug: 'apex-threads' },
    update: {},
    create: {
      name: 'Apex Threads',
      slug: 'apex-threads',
      description: 'Modern, minimalist wardrobe essentials.'
    }
  });

  const brandLumina = await prisma.brand.upsert({
    where: { slug: 'lumina-audio' },
    update: {},
    create: {
      name: 'Lumina Audio',
      slug: 'lumina-audio',
      description: 'Precision acoustic hardware engineered for audiophiles.'
    }
  });

  // 5. Seed Categories
  console.log('📁 Seeding categories...');
  const catFashion = await prisma.category.upsert({
    where: { slug: 'fashion' },
    update: {},
    create: {
      name: 'Fashion & Apparel',
      slug: 'fashion',
      description: 'Curated modern fashion and accessories.'
    }
  });

  const catMenShirts = await prisma.category.upsert({
    where: { slug: 'mens-shirts' },
    update: {},
    create: {
      name: "Men's Shirts",
      slug: 'mens-shirts',
      parentId: catFashion.id,
      description: 'Oxford, linen, and everyday button-downs.'
    }
  });

  const catElectronics = await prisma.category.upsert({
    where: { slug: 'electronics' },
    update: {},
    create: {
      name: 'Electronics & Audio',
      slug: 'electronics',
      description: 'Premium personal audio and computing gear.'
    }
  });

  // 6. Seed Products with Variants & Images
  console.log('📦 Seeding products with variants...');

  // Product 1: Fashion Oxford Shirt
  const oxfordShirt = await prisma.product.upsert({
    where: { slug: 'classic-oxford-shirt' },
    update: {},
    create: {
      title: 'Classic Tailored Oxford Shirt',
      slug: 'classic-oxford-shirt',
      description: 'Woven from 100% organic Supima cotton. Features mother-of-pearl buttons and a comfortable relaxed-tailored silhouette.',
      shortDescription: '100% organic cotton everyday oxford.',
      sku: 'APX-OXF-001',
      basePrice: 58.00,
      comparePrice: 75.00,
      costPrice: 22.00,
      stock: 40,
      hasVariants: true,
      isFeatured: true,
      categoryId: catMenShirts.id,
      brandId: brandApex.id,
      metadata: {
        fabric: '100% Organic Supima Cotton',
        care: 'Machine wash cold, tumble dry low',
        fit: 'Regular Fit'
      },
      images: {
        create: [
          {
            url: 'https://images.unsplash.com/photo-1596755094514-f87e34085b2c?auto=format&fit=crop&w=800&q=80',
            altText: 'Classic Oxford Shirt front view',
            sortOrder: 0,
            isThumbnail: true
          }
        ]
      },
      variants: {
        create: [
          {
            title: 'Medium / Light Blue',
            sku: 'APX-OXF-001-M-BLU',
            price: 58.00,
            stock: 20,
            attributes: { size: 'M', color: 'Light Blue' }
          },
          {
            title: 'Large / Light Blue',
            sku: 'APX-OXF-001-L-BLU',
            price: 58.00,
            stock: 20,
            attributes: { size: 'L', color: 'Light Blue' }
          }
        ]
      }
    }
  });

  // Product 2: Wireless ANC Headphones
  const headphones = await prisma.product.upsert({
    where: { slug: 'lumina-wireless-anc-headphones' },
    update: {},
    create: {
      title: 'Lumina Horizon Wireless ANC Headphones',
      slug: 'lumina-wireless-anc-headphones',
      description: 'Active hybrid noise cancellation with 40mm beryllium drivers, 36-hour battery life, and ultra-plush memory foam earcups.',
      shortDescription: 'Studio-grade acoustics with hybrid active noise cancellation.',
      sku: 'LUM-HZN-ANC',
      basePrice: 199.00,
      comparePrice: 249.00,
      costPrice: 90.00,
      stock: 25,
      hasVariants: false,
      isFeatured: true,
      categoryId: catElectronics.id,
      brandId: brandLumina.id,
      metadata: {
        batteryLife: '36 hours',
        connectivity: 'Bluetooth 5.3 + 3.5mm AUX',
        driverSize: '40mm Beryllium',
        warranty: '2 Years Manufacturer'
      },
      images: {
        create: [
          {
            url: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=800&q=80',
            altText: 'Lumina Wireless Headphones in Matte Black',
            sortOrder: 0,
            isThumbnail: true
          }
        ]
      }
    }
  });

  console.log('✅ Seeding complete!');
  console.log(`👤 Admin Account: ${admin.email} (Password: AdminPassword123!)`);
  console.log(`👤 Customer Account: ${customer.email} (Password: Customer123!)`);
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
