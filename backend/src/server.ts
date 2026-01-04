import express from "express";

const app = express();
const PORT = process.env.PORT || 4000;

app.get("/api/health", (req, res) => {
  res.json({ status: "OK", message: "KhataSathi API running" });
});

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
