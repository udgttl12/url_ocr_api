export const swaggerSpec = {
  openapi: "3.0.3",
  info: {
    title: "OCR API",
    version: "1.0.0",
    description: "이미지를 업로드하면 OCR 텍스트를 반환하는 REST API. DeepSeek OCR2 엔진을 사용합니다.",
  },
  servers: [
    { url: "http://localhost:3100", description: "Local development" },
  ],
  paths: {
    "/api/health": {
      get: {
        tags: ["System"],
        summary: "헬스 체크",
        responses: {
          200: {
            description: "서버 정상 동작",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                    uptime: { type: "number", example: 123.45 },
                    timestamp: { type: "string", example: "2026-03-04T12:00:00.000Z" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/ocr/engines": {
      get: {
        tags: ["OCR"],
        summary: "사용 가능한 OCR 엔진 목록",
        responses: {
          200: {
            description: "엔진 목록",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    engines: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          description: { type: "string" },
                        },
                      },
                    },
                  },
                },
                example: {
                  engines: [
                    { name: "deepseek", description: "DeepSeek OCR2 (CUDA required)" },
                  ],
                },
              },
            },
          },
        },
      },
    },
    "/api/ocr": {
      post: {
        tags: ["OCR"],
        summary: "이미지 OCR 수행",
        description: "이미지 파일을 업로드하거나 imageUrl을 전달하여 OCR을 수행합니다. `async=true` 쿼리 파라미터로 비동기 모드를 사용할 수 있습니다.",
        parameters: [
          {
            name: "async",
            in: "query",
            description: "true로 설정하면 비동기 모드 (202 + jobId 반환)",
            schema: { type: "boolean", default: false },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: {
                  image: {
                    type: "string",
                    format: "binary",
                    description: "OCR할 이미지 파일",
                  },
                  imageUrl: {
                    type: "string",
                    description: "이미지 URL (image 파일 대신 사용)",
                  },
                  engine: {
                    type: "string",
                    enum: ["deepseek"],
                    default: "deepseek",
                    description: "사용할 OCR 엔진",
                  },
                  ocrMode: {
                    type: "string",
                    enum: ["normal"],
                    default: "normal",
                    description: "DeepSeek OCR 모드",
                  },
                  scale: {
                    type: "number",
                    default: 4,
                    description: "전처리 스케일 배율",
                  },
                  parts: {
                    type: "integer",
                    default: 4,
                    description: "이미지 분할 수",
                  },
                },
              },
            },
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  imageUrl: {
                    type: "string",
                    description: "이미지 URL",
                  },
                  engine: {
                    type: "string",
                    enum: ["deepseek"],
                    default: "deepseek",
                  },
                  ocrMode: {
                    type: "string",
                    enum: ["normal"],
                    default: "normal",
                  },
                  scale: { type: "number", default: 4 },
                  parts: { type: "integer", default: 4 },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "동기 모드 - OCR 결과",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/OcrResult" },
              },
            },
          },
          202: {
            description: "비동기 모드 - 작업 생성됨",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    jobId: { type: "string", format: "uuid" },
                    status: { type: "string", example: "pending" },
                    pollUrl: { type: "string", example: "/api/ocr/jobs/uuid" },
                  },
                },
              },
            },
          },
          400: {
            description: "잘못된 요청",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/api/ocr/extract": {
      post: {
        tags: ["OCR"],
        summary: "웹 페이지 URL에서 이미지 추출 후 OCR 수행",
        description:
          "웹 페이지 URL을 Playwright로 열고, 페이지 내 이미지를 자동 추출하여 각 이미지에 OCR을 수행합니다. 네이버 카페 iframe도 자동 처리됩니다. `async=true` 쿼리 파라미터로 비동기 모드를 사용할 수 있습니다.",
        parameters: [
          {
            name: "async",
            in: "query",
            description: "true로 설정하면 비동기 모드 (202 + jobId 반환)",
            schema: { type: "boolean", default: false },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["url"],
                properties: {
                  url: {
                    type: "string",
                    description: "이미지를 추출할 웹 페이지 URL",
                    example: "https://example.com",
                  },
                  engine: {
                    type: "string",
                    enum: ["deepseek"],
                    default: "deepseek",
                    description: "사용할 OCR 엔진",
                  },
                  ocrMode: {
                    type: "string",
                    enum: ["normal"],
                    default: "normal",
                    description: "DeepSeek OCR 모드",
                  },
                  scale: { type: "number", default: 4, description: "전처리 스케일 배율" },
                  parts: { type: "integer", default: 4, description: "이미지 분할 수" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "동기 모드 - 추출 및 OCR 결과",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ExtractResult" },
              },
            },
          },
          202: {
            description: "비동기 모드 - 작업 생성됨",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    jobId: { type: "string", format: "uuid" },
                    status: { type: "string", example: "pending" },
                    pollUrl: { type: "string", example: "/api/ocr/jobs/uuid" },
                  },
                },
              },
            },
          },
          400: {
            description: "잘못된 요청",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/api/ocr/jobs/{jobId}": {
      get: {
        tags: ["OCR"],
        summary: "비동기 OCR 작업 상태/결과 조회",
        parameters: [
          {
            name: "jobId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: {
            description: "작업 상태/결과",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    jobId: { type: "string" },
                    status: { type: "string", enum: ["pending", "processing", "completed", "failed"] },
                    createdAt: { type: "string" },
                    updatedAt: { type: "string" },
                    result: { $ref: "#/components/schemas/OcrResultData" },
                    error: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
          404: {
            description: "작업을 찾을 수 없음",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/api/results": {
      get: {
        tags: ["Results"],
        summary: "저장된 OCR 결과 목록",
        description: "out/ 폴더에 저장된 모든 추출 결과를 반환합니다. 각 결과의 파일 URL도 포함됩니다.",
        responses: {
          200: {
            description: "결과 목록",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    count: { type: "integer" },
                    results: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          url: { type: "string" },
                          meta: { type: "object" },
                          engine: { type: "string" },
                          imageCount: { type: "integer" },
                          createdAt: { type: "string" },
                          files: { type: "object" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/results/{name}": {
      get: {
        tags: ["Results"],
        summary: "특정 결과의 전체 텍스트 반환",
        parameters: [
          { name: "name", in: "path", required: true, schema: { type: "string" }, description: "결과 폴더명" },
        ],
        responses: {
          200: { description: "전체 텍스트", content: { "text/plain": { schema: { type: "string" } } } },
          404: { description: "결과 없음", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["Results"],
        summary: "특정 결과 삭제",
        parameters: [
          { name: "name", in: "path", required: true, schema: { type: "string" }, description: "결과 폴더명" },
        ],
        responses: {
          200: { description: "삭제 완료", content: { "application/json": { schema: { type: "object", properties: { status: { type: "string" }, name: { type: "string" } } } } } },
        },
      },
    },
  },
  components: {
    schemas: {
      OcrResultData: {
        type: "object",
        properties: {
          selectedEngine: { type: "string", example: "deepseek" },
          text: { type: "string", example: "추출된 텍스트..." },
          score: { type: "number", example: 87.5 },
          candidates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                engine: { type: "string" },
                text: { type: "string" },
                score: { type: "number" },
              },
            },
          },
          warnings: { type: "array", items: { type: "string" } },
          timings: {
            type: "object",
            properties: {
              preprocessMs: { type: "number" },
              ocrMs: { type: "number" },
              totalMs: { type: "number" },
            },
          },
        },
      },
      OcrResult: {
        type: "object",
        properties: {
          status: { type: "string", example: "completed" },
          result: { $ref: "#/components/schemas/OcrResultData" },
        },
      },
      ExtractResult: {
        type: "object",
        properties: {
          status: { type: "string", example: "completed" },
          url: { type: "string", example: "https://example.com" },
          meta: {
            type: "object",
            properties: {
              title: { type: "string" },
              author: { type: "string" },
              date: { type: "string" },
            },
          },
          pageText: { type: "string", description: "페이지에서 추출된 일반 텍스트" },
          images: {
            type: "array",
            items: {
              type: "object",
              properties: {
                index: { type: "integer" },
                imageUrl: { type: "string" },
                ocr: {
                  type: "object",
                  nullable: true,
                  properties: {
                    selectedEngine: { type: "string" },
                    text: { type: "string" },
                    score: { type: "number" },
                  },
                },
                error: { type: "string", nullable: true },
              },
            },
          },
          fullText: { type: "string", description: "pageText + 모든 이미지 OCR 텍스트를 합친 최종 텍스트" },
        },
      },
      Error: {
        type: "object",
        properties: {
          error: { type: "string" },
        },
      },
    },
  },
};
