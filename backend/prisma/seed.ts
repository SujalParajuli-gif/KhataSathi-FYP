// prisma/seed.ts — Seed the database with initial data
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
    console.log("🌱 Seeding KhataSathi database...\n");

    // ─── 1. Users ─────────────────────────────────────
    const adminPw = await bcrypt.hash("Admin@123", 10);
    const cashierPw = await bcrypt.hash("Cashier@123", 10);

    const admin = await prisma.user.upsert({
        where: { email: "admin@khatasathi.com" },
        update: {},
        create: {
            name: "Admin User",
            email: "admin@khatasathi.com",
            passwordHash: adminPw,
            role: "ADMIN",
            isActive: true,
        },
    });

    const cashier = await prisma.user.upsert({
        where: { email: "cashier@khatasathi.com" },
        update: {},
        create: {
            name: "Cashier User",
            email: "cashier@khatasathi.com",
            passwordHash: cashierPw,
            role: "CASHIER",
            isActive: true,
        },
    });

    console.log("✅ Users seeded:");
    console.log(`   Admin:   admin@khatasathi.com   / Admin@123`);
    console.log(`   Cashier: cashier@khatasathi.com / Cashier@123\n`);

    // ─── 2. Brands ────────────────────────────────────
    const brandNames = [
        "CG Foods",
        "Goldstar",
        "Himalayan Java",
        "Reckitt",
        "Dhara",
        "Balaji",
    ];

    const brands: Record<string, any> = {};
    for (const name of brandNames) {
        brands[name] = await prisma.brand.upsert({
            where: { name },
            update: {},
            create: { name, isActive: true },
        });
    }
    console.log(`✅ ${brandNames.length} brands seeded.\n`);

    // ─── 3. Products ──────────────────────────────────
    const productData = [
        {
            name: "Wai Wai Noodles (Chicken)",
            sku: "SKU-001",
            barcode: "890123456789",
            brandName: "CG Foods",
            category: "Groceries",
            retailPrice: 25,
            wholesalePrice: 22.5,
            wholesaleQtyThreshold: 100,
            stock: 2450,
            lowStockThreshold: 20,
        },
        {
            name: "Goldstar 032 - Black",
            sku: "SKU-002",
            barcode: "987654321012",
            brandName: "Goldstar",
            category: "Footwear",
            retailPrice: 950,
            wholesalePrice: 820,
            wholesaleQtyThreshold: 20,
            stock: 145,
            lowStockThreshold: 10,
        },
        {
            name: "Mustang Marpha Rice (25kg)",
            sku: "SKU-003",
            barcode: "456789123456",
            brandName: "Himalayan Java",
            category: "Grains",
            retailPrice: 3200,
            wholesalePrice: 2950,
            wholesaleQtyThreshold: 10,
            stock: 4,
            lowStockThreshold: 6,
        },
        {
            name: "Dettol Soap Original",
            sku: "SKU-004",
            barcode: "112233445566",
            brandName: "Reckitt",
            category: "Personal Care",
            retailPrice: 65,
            wholesalePrice: 58,
            wholesaleQtyThreshold: 50,
            stock: 312,
            lowStockThreshold: 20,
        },
        {
            name: "Dhara Mustard Oil (1L)",
            sku: "SKU-005",
            barcode: "998877665544",
            brandName: "Dhara",
            category: "Groceries",
            retailPrice: 280,
            wholesalePrice: 265,
            wholesaleQtyThreshold: 24,
            stock: 86,
            lowStockThreshold: 12,
        },
        {
            name: "Balaji Wafers (Masala)",
            sku: "SKU-006",
            barcode: "777888999000",
            brandName: "Balaji",
            category: "Snacks",
            retailPrice: 20,
            wholesalePrice: 17,
            wholesaleQtyThreshold: 48,
            stock: 110,
            lowStockThreshold: 18,
        },
    ];

    for (const p of productData) {
        await prisma.product.upsert({
            where: { sku: p.sku },
            update: {},
            create: {
                name: p.name,
                sku: p.sku,
                barcode: p.barcode,
                brandId: brands[p.brandName].id,
                category: p.category,
                retailPrice: p.retailPrice,
                wholesalePrice: p.wholesalePrice,
                wholesaleQtyThreshold: p.wholesaleQtyThreshold,
                stock: p.stock,
                lowStockThreshold: p.lowStockThreshold,
                isActive: true,
            },
        });
    }
    console.log(`✅ ${productData.length} products seeded.\n`);

    // ─── 4. Customers ─────────────────────────────────
    const customers = [
        { name: "Ramesh Sharma", phone: "9841234567", loyaltyPercent: 5 },
        { name: "Sita Thapa", phone: "9812345678", loyaltyPercent: 10 },
    ];

    for (const c of customers) {
        await prisma.customer.upsert({
            where: { phone: c.phone },
            update: {},
            create: {
                name: c.name,
                phone: c.phone,
                loyaltyPercent: c.loyaltyPercent,
                isActive: true,
            },
        });
    }
    console.log(`✅ ${customers.length} customers seeded.\n`);

    console.log("🎉 Seeding complete!");
}

main()
    .catch((e) => {
        console.error("❌ Seed error:", e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
