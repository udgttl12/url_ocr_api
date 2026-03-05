import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import swaggerUi from "swagger-ui-express";
import apiRouter from "./src/api/routes.mjs";
import { swaggerSpec } from "./src/api/swagger.mjs";
import { errorHandler } from "./src/api/middleware.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3100;

// Body parsing
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Swagger UI
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// out/ 폴더 정적 서빙 - 브라우저에서 결과 파일 직접 확인
app.use("/out", express.static(path.join(__dirname, "out")));

// API routes
app.use("/api", apiRouter);

// Root redirect to docs
app.get("/", (_req, res) => {
  res.redirect("/docs");
});

// Error handler
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`OCR API server running at http://localhost:${PORT}`);
  console.log(`Swagger UI: http://localhost:${PORT}/docs`);
  console.log(`Results:    http://localhost:${PORT}/api/results`);
});
