import { Request, Response } from "express";
import * as brandService from "./service";

// listing all brands, with optional filtering for active-only brands
export async function list(req: Request, res: Response) {
    try {
        const activeOnly = req.query.active === "true"; // checking if the frontend only wants active brands
        const brands = await brandService.listBrands(activeOnly);
        res.json(brands);
    } catch (err) {
        console.error("List brands error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

// fetching a single brand by its ID, including its linked products
export async function getOne(req: Request, res: Response) {
    try {
        const brand = await brandService.getBrand(String(req.params.id));
        if (!brand) {
            res.status(404).json({ error: "Brand not found" });
            return;
        }
        res.json(brand);
    } catch (err) {
        console.error("Get brand error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

// creating a new brand — only the name is required
export async function create(req: Request, res: Response) {
    try {
        const { name } = req.body;
        // validating that the brand name is provided and not just whitespace
        if (!name || !name.trim()) {
            res.status(400).json({ error: "Brand name is required" });
            return;
        }
        const brand = await brandService.createBrand(name.trim());
        res.status(201).json(brand);
    } catch (err: any) {
        // P2002 is Prisma's error code for unique constraint violation — means a brand with this name already exists
        if (err.code === "P2002") {
            res.status(409).json({ error: "Brand name already exists" });
            return;
        }
        console.error("Create brand error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

// updating an existing brand — can change the name or active status
export async function update(req: Request, res: Response) {
    try {
        const { name, isActive } = req.body;
        const brand = await brandService.updateBrand(
            String(req.params.id),
            { name, isActive },
            req.user?.id, // passing the actor ID so the service can create an audit log entry
        );
        res.json(brand);
    } catch (err: any) {
        // P2025 means the record was not found in the database
        if (err.code === "P2025") {
            res.status(404).json({ error: "Brand not found" });
            return;
        }
        if (err.code === "P2002") {
            res.status(409).json({ error: "Brand name already exists" });
            return;
        }
        console.error("Update brand error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

// deactivating a brand — this also deactivates all products under that brand
export async function deactivate(req: Request, res: Response) {
    try {
        const brand = await brandService.deactivateBrand(String(req.params.id), req.user?.id);
        res.json(brand);
    } catch (err: any) {
        if (err.code === "P2025") {
            res.status(404).json({ error: "Brand not found" });
            return;
        }
        console.error("Deactivate brand error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}
