// src/modules/payments/service.ts — Payment business logic
import prisma from "../../db/prisma";

/**
 * Add a payment to an invoice.
 * Enforces: sum of SUCCESS payments must not exceed netTotal.
 */
export async function addPayment(
    invoiceId: string,
    method: "CASH" | "ESEWA" | "KHALTI",
    amount: number,
    status: "PENDING" | "SUCCESS" | "FAILED",
    createdById: string,
    reference?: string
) {
    // Get the invoice
    const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: true },
    });

    if (!invoice) throw new Error("Invoice not found");

    // If this payment is SUCCESS, check overpayment
    if (status === "SUCCESS") {
        const currentPaid = invoice.payments
            .filter((p) => p.status === "SUCCESS")
            .reduce((sum, p) => sum + p.amount, 0);

        if (currentPaid + amount > invoice.netTotal) {
            throw new Error(
                `Overpayment! Current paid: Rs ${currentPaid}, new: Rs ${amount}, net total: Rs ${invoice.netTotal}. Max allowed: Rs ${invoice.netTotal - currentPaid}`
            );
        }
    }

    // Create the payment record
    const payment = await prisma.payment.create({
        data: {
            invoiceId,
            method,
            amount,
            status,
            reference: reference || null,
            createdById,
        },
    });

    // Recompute paidTotal and paymentStatus
    await recomputePaymentStatus(invoiceId);

    return payment;
}

/**
 * Recompute paidTotal and paymentStatus on an invoice after payment changes.
 */
async function recomputePaymentStatus(invoiceId: string) {
    const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: true },
    });
    if (!invoice) return;

    const paidTotal = invoice.payments
        .filter((p) => p.status === "SUCCESS")
        .reduce((sum, p) => sum + p.amount, 0);

    let paymentStatus: "UNPAID" | "PARTIALLY_PAID" | "PAID" = "UNPAID";
    if (paidTotal >= invoice.netTotal && invoice.netTotal > 0) {
        paymentStatus = "PAID";
    } else if (paidTotal > 0) {
        paymentStatus = "PARTIALLY_PAID";
    }

    await prisma.invoice.update({
        where: { id: invoiceId },
        data: { paidTotal, paymentStatus },
    });
}

export async function listPayments(invoiceId: string) {
    return prisma.payment.findMany({
        where: { invoiceId },
        include: { createdBy: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
    });
}
