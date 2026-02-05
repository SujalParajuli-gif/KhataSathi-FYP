import express from "express";

const app = express();

// declaring for this... so we can reuse it later if we add more routes
const PORT = Number(process.env.PORT) || 4000;

// this function is passed to... check if backend is running properly
app.get("/api/health", (_req, res) => {
  res.json({ status: "OK", message: "KhataSathi API running" });
});

// declaring for this... so Docker can access it from outside the container
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend running on port ${PORT}`);
});
