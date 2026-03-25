import { Request, Response } from "express";
import * as paymentService from "./service";

export async function addPayment(req: Request, res: Response) {
    try {
        const { method, amount, status, reference } = req.body;

        if (!method || !amount || amount <= 0) {
            res.status(400).json({ error: "method and amount (> 0) are required" });
            return;
        }

        const validMethods = ["CASH", "ESEWA", "KHALTI"];
        if (!validMethods.includes(method)) {
            res.status(400).json({ error: `method must be one of: ${validMethods.join(", ")}` });
            return;
        }

        const validStatuses = ["PENDING", "SUCCESS", "FAILED"];
        const paymentStatus = status || "SUCCESS";
        if (!validStatuses.includes(paymentStatus)) {
            res.status(400).json({ error: `status must be one of: ${validStatuses.join(", ")}` });
            return;
        }

        const payment = await paymentService.addPayment(
            req.params.id,
            method,
            Number(amount),
            paymentStatus,
            req.user!.id,
            reference
        );

        res.status(201).json(payment);
    } catch (err: any) {
        if (err.message.includes("Overpayment") || err.message.includes("not found")) {
            res.status(400).json({ error: err.message });
            return;
        }
        console.error("Add payment error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

export async function listPayments(req: Request, res: Response) {
    try {
        const payments = await paymentService.listPayments(req.params.id);
        res.json(payments);
    } catch (err) {
        console.error("List payments error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}
