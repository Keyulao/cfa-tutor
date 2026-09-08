import OpenAI from "openai";
import type {
  EasyInputMessage,
  Response,
  ResponseInput,
  ResponseInputContent,
} from "openai/resources/responses/responses";
import { CFA_SYSTEM_INSTRUCTIONS, OPENAI_MODEL } from "@/lib/openai-config";

export const runtime = "nodejs";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  images?: ChatImage[];
};

type ChatImage = {
  name: string;
  type: string;
  size: number;
  dataUrl: string;
};

const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGES_PER_CONVERSATION = 12;

function curriculumSourceLabel(filename: string) {
  const match = filename.match(/^cfa-program2026L1V(\d+)\.pdf$/i);
  return match ? `CFA Level I 2026 · Volume ${Number(match[1])}` : filename;
}

function getRetrievedCurriculumSources(response: Response) {
  const filenames = new Set<string>();

  for (const item of response.output) {
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type !== "output_text") continue;
      for (const annotation of content.annotations) {
        if (annotation.type === "file_citation") {
          filenames.add(annotation.filename);
        }
      }
    }
  }

  return [...filenames]
    .map(curriculumSourceLabel)
    .sort((left, right) => {
      const leftVolume = Number(left.match(/Volume (\d+)/)?.[1] ?? Number.MAX_SAFE_INTEGER);
      const rightVolume = Number(right.match(/Volume (\d+)/)?.[1] ?? Number.MAX_SAFE_INTEGER);
      return leftVolume - rightVolume || left.localeCompare(right);
    });
}

function parseImageDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return null;

  const padding = match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0;
  return {
    type: match[1],
    bytes: Math.floor((match[2].length * 3) / 4) - padding,
  };
}

function isChatImage(value: unknown): value is ChatImage {
  if (!value || typeof value !== "object") return false;

  const image = value as Record<string, unknown>;
  if (
    typeof image.name !== "string" ||
    image.name.length === 0 ||
    image.name.length > 255 ||
    typeof image.type !== "string" ||
    !SUPPORTED_IMAGE_TYPES.has(image.type) ||
    typeof image.size !== "number" ||
    typeof image.dataUrl !== "string"
  ) {
    return false;
  }

  const parsed = parseImageDataUrl(image.dataUrl);
  return Boolean(
    parsed &&
      parsed.type === image.type &&
      parsed.bytes > 0 &&
      parsed.bytes <= MAX_IMAGE_BYTES &&
      image.size === parsed.bytes,
  );
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;

  const message = value as Record<string, unknown>;
  const contentIsValid =
    typeof message.content === "string" && message.content.length <= 20_000;
  const imagesAreValid =
    message.images === undefined ||
    (Array.isArray(message.images) &&
      message.images.length <= MAX_IMAGES_PER_MESSAGE &&
      message.images.every(isChatImage));
  const hasContent =
    contentIsValid &&
    ((message.content as string).trim().length > 0 ||
      (Array.isArray(message.images) && message.images.length > 0));

  return (
    (message.role === "user" || message.role === "assistant") &&
    contentIsValid &&
    imagesAreValid &&
    hasContent &&
    (message.role === "user" || message.images === undefined)
  );
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  const vectorStoreId = process.env.CFA_VECTOR_STORE_ID;

  if (!apiKey || apiKey === "PASTE_YOUR_KEY_HERE") {
    return Response.json(
      { error: "OpenAI API key 尚未配置。请检查 .env.local。" },
      { status: 500 },
    );
  }

  if (!vectorStoreId) {
    return Response.json(
      { error: "CFA 教材知识库尚未配置。请先运行 npm run ingest:curriculum。" },
      { status: 500 },
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求内容不是有效的 JSON。" }, { status: 400 });
  }

  const messages =
    body && typeof body === "object" && Array.isArray((body as { messages?: unknown }).messages)
      ? (body as { messages: unknown[] }).messages
      : null;

  if (!messages || messages.length === 0 || messages.length > 40 || !messages.every(isChatMessage)) {
    return Response.json({ error: "对话内容无效或过长。" }, { status: 400 });
  }

  const conversationImages = messages.flatMap((message) => message.images ?? []);
  const totalImageBytes = conversationImages.reduce((total, image) => total + image.size, 0);

  if (
    conversationImages.length > MAX_IMAGES_PER_CONVERSATION ||
    totalImageBytes > MAX_TOTAL_IMAGE_BYTES
  ) {
    return Response.json({ error: "当前对话中的图片数量或总大小超出限制。" }, { status: 413 });
  }

  try {
    const client = new OpenAI({ apiKey });
    const input: ResponseInput = messages.map((message): EasyInputMessage => {
      if (message.role === "assistant") {
        return { role: "assistant", content: message.content };
      }

      const content: ResponseInputContent[] = [
        {
          type: "input_text",
          text:
            message.content.trim() ||
            "请分析这张 CFA 错题截图，识别题干、选项与相关信息，并按 CFA Tutor 的教学方式讲解。",
        },
        ...(message.images ?? []).map((image) => ({
          type: "input_image" as const,
          image_url: image.dataUrl,
          detail: "original" as const,
        })),
      ];

      return { role: "user", content };
    });

    const response = await client.responses.create({
      model: OPENAI_MODEL,
      instructions: CFA_SYSTEM_INSTRUCTIONS,
      input,
      tools: [
        {
          type: "file_search",
          vector_store_ids: [vectorStoreId],
          max_num_results: 8,
        },
      ],
      tool_choice: "auto",
      reasoning: { effort: "medium" },
      max_output_tokens: 4_000,
      store: false,
    });

    const reply = response.output_text.trim();

    if (!reply) {
      return Response.json({ error: "模型没有返回文字内容，请重试。" }, { status: 502 });
    }

    const sources = getRetrievedCurriculumSources(response);
    const message = sources.length
      ? `${reply}\n\n---\n\n教材参考：\n${sources.map((source) => `- ${source}`).join("\n")}`
      : reply;

    return Response.json({ message, sources });
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error
        ? Number((error as { status?: unknown }).status)
        : 500;

    if (status === 401) {
      return Response.json({ error: "OpenAI API key 无效，请检查 .env.local。" }, { status: 502 });
    }

    if (status === 429) {
      return Response.json(
        { error: "OpenAI API 请求过于频繁或可用额度不足，请稍后重试。" },
        { status: 503 },
      );
    }

    return Response.json({ error: "暂时无法连接 CFA Tutor，请稍后重试。" }, { status: 502 });
  }
}
