import { Request, Response } from "express";
import * as brandService from "./service";

export async function list(req: Request, res: Response) {
    try {
        const activeOnly = req.query.active === "true";
        const brands = await brandService.listBrands(activeOnly);
        res.json(brands);
    } catch (err) {
        console.error("List brands error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

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

export async function create(req: Request, res: Response) {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) {
            res.status(400).json({ error: "Brand name is required" });
            return;
        }
        const brand = await brandService.createBrand(name.trim());
        res.status(201).json(brand);
    } catch (err: any) {
        if (err.code === "P2002") {
            res.status(409).json({ error: "Brand name already exists" });
            return;
        }
        console.error("Create brand error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

export async function update(req: Request, res: Response) {
    try {
        const { name, isActive } = req.body;
        const brand = await brandService.updateBrand(
            String(req.params.id),
            { name, isActive },
            req.user?.id,
        );
        res.json(brand);
    } catch (err: any) {
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
