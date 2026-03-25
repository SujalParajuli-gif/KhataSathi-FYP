import { Request, Response } from "express";
import * as reportService from "./service";

export async function salesSummary(req: Request, res: Response) {
    try {
        const { from, to } = req.query;
        if (!from || !to) {
            res.status(400).json({ error: "from and to query params required (YYYY-MM-DD)" });
            return;
        }
        const result = await reportService.salesSummary(from as string, to as string);
        res.json(result);
    } catch (err) {
        console.error("Sales summary error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

export async function bestSellers(req: Request, res: Response) {
    try {
        const { from, to, limit } = req.query;
        if (!from || !to) {
            res.status(400).json({ error: "from and to query params required" });
            return;
        }
        const result = await reportService.bestSellers(
            from as string,
            to as string,
            limit ? Number(limit) : 10
        );
        res.json(result);
    } catch (err) {
        console.error("Best sellers error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

export async function cashierSales(req: Request, res: Response) {
    try {
        const { from, to } = req.query;
        if (!from || !to) {
            res.status(400).json({ error: "from and to query params required" });
            return;
        }
        const result = await reportService.cashierSales(from as string, to as string);
        res.json(result);
    } catch (err) {
        console.error("Cashier sales error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}
