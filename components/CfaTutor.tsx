"use client";

import {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  KeyboardEvent,
  useRef,
  useState,
} from "react";
import { MarkdownMessage } from "@/components/MarkdownMessage";

type ChatImage = {
  id: string;
  name: string;
  type: string;
  size: number;
  src: string;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  text?: string;
  images?: ChatImage[];
  error?: boolean;
};

const mockHistory = [
  "Equity valuation question",
  "Duration vs. convexity",
  "Ethics: material nonpublic info",
  "Deferred tax liabilities",
];

const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 4;

function fileToImage(file: File): Promise<ChatImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const extension = file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1];
    const name = file.name || `pasted-image.${extension}`;
    reader.onload = () =>
      resolve({
        id: `${name}-${file.lastModified}-${crypto.randomUUID()}`,
        name,
        type: file.type,
        size: file.size,
        src: String(reader.result),
      });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function CfaTutor() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [text, setText] = useState("");
  const [images, setImages] = useState<ChatImage[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const requestInFlightRef = useRef(false);
  const requestControllerRef = useRef<AbortController | null>(null);

  const addFiles = async (files: FileList | File[]) => {
    const selectedFiles = Array.from(files);
    const unsupportedFile = selectedFiles.find((file) => !SUPPORTED_IMAGE_TYPES.has(file.type));
    const oversizedFile = selectedFiles.find((file) => file.size > MAX_IMAGE_BYTES);

    if (unsupportedFile) {
      setAttachmentError("仅支持 PNG、JPEG 和 WebP 图片。");
      return;
    }

    if (oversizedFile) {
      setAttachmentError("每张图片不能超过 10 MB。");
      return;
    }

    if (images.length + selectedFiles.length > MAX_IMAGES) {
      setAttachmentError("每条消息最多添加 4 张图片。");
      return;
    }

    const totalBytes = [...images, ...selectedFiles].reduce((total, image) => total + image.size, 0);
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      setAttachmentError("每条消息的图片总大小不能超过 20 MB。");
      return;
    }

    try {
      const nextImages = await Promise.all(selectedFiles.map(fileToImage));
      setImages((current) => [...current, ...nextImages]);
      setAttachmentError("");
    } catch {
      setAttachmentError("图片读取失败，请重新选择。");
    }
  };

  const resetTextarea = () => {
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    });
  };

  const sendMessage = async () => {
    const cleanText = text.trim();
    if ((!cleanText && !images.length) || requestInFlightRef.current) return;

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      text: cleanText,
      images,
    };

    setMessages((current) => [...current, userMessage]);
    setText("");
    setImages([]);
    resetTextarea();
    scrollToBottom();

    requestInFlightRef.current = true;
    setIsThinking(true);
    const controller = new AbortController();
    requestControllerRef.current = controller;

    const apiMessages = [...messages, userMessage]
      .filter((message) => !message.error && (message.text || message.images?.length))
      .map((message) => ({
        role: message.role,
        content: message.text ?? "",
        ...(message.images?.length
          ? {
              images: message.images.map((image) => ({
                name: image.name,
                type: image.type,
                size: image.size,
                dataUrl: image.src,
              })),
            }
          : {}),
      }));

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages }),
        signal: controller.signal,
      });
      const result = (await response.json()) as { message?: string; error?: string };

      if (!response.ok || !result.message) {
        throw new Error(result.error || "CFA Tutor 暂时无法回答，请稍后重试。");
      }

      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: "assistant", text: result.message },
      ]);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;

      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: error instanceof Error ? error.message : "CFA Tutor 暂时无法回答，请稍后重试。",
          error: true,
        },
      ]);
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
        requestInFlightRef.current = false;
        setIsThinking(false);
        scrollToBottom();
      }
    }
  };

  const startNewChat = () => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    requestInFlightRef.current = false;
    setMessages([]);
    setText("");
    setImages([]);
    setAttachmentError("");
    setIsThinking(false);
    setMobileSidebarOpen(false);
    resetTextarea();
  };

  const handleTextareaChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.target.value);
    event.target.style.height = "auto";
    event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedImages = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (pastedImages.length) {
      event.preventDefault();
      void addFiles(pastedImages);
    }
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragging(false);
    void addFiles(event.dataTransfer.files);
  };

  const canSend = Boolean(text.trim() || images.length) && !isThinking;

  return (
    <div className="app-shell">
      {mobileSidebarOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Close sidebar"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      <aside
        className={`sidebar ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${
          mobileSidebarOpen ? "sidebar-mobile-open" : ""
        }`}
      >
        <div className="sidebar-header">
          <div className="brand-mark">C</div>
          {!sidebarCollapsed && <span className="brand-name">CFA Tutor</span>}
          <button
            className="sidebar-toggle desktop-only"
            onClick={() => setSidebarCollapsed((current) => !current)}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? "›" : "‹"}
          </button>
          <button
            className="sidebar-toggle mobile-only"
            onClick={() => setMobileSidebarOpen(false)}
            aria-label="Close sidebar"
          >
            ×
          </button>
        </div>

        <button className="new-chat-button" onClick={startNewChat} title="New chat">
          <span className="new-chat-plus">+</span>
          {!sidebarCollapsed && <span>New Chat</span>}
        </button>

        {!sidebarCollapsed && (
          <nav className="history" aria-label="Conversation history">
            <p className="history-label">Recent</p>
            {mockHistory.map((item, index) => (
              <button key={item} className={index === 0 ? "history-active" : ""}>
                {item}
              </button>
            ))}
          </nav>
        )}

        <div className="sidebar-footer">
          <div className="status-dot" />
          {!sidebarCollapsed && <span>Local workspace</span>}
        </div>
      </aside>

      <main
        className={`main-panel ${isDragging ? "is-dragging" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) setIsDragging(false);
        }}
        onDrop={handleDrop}
      >
        <header className="mobile-header">
          <button onClick={() => setMobileSidebarOpen(true)} aria-label="Open sidebar">
            ☰
          </button>
          <span>CFA Tutor</span>
          <button onClick={startNewChat} aria-label="New chat">
            +
          </button>
        </header>

        {isDragging && (
          <div className="drop-overlay">
            <div>
              <span>+</span>
              <strong>Drop image here</strong>
              <small>Ready for visual analysis</small>
            </div>
          </div>
        )}

        <div className="conversation" ref={scrollRef}>
          {messages.length === 0 ? (
            <section className="empty-state">
              <div className="empty-icon">C</div>
              <h1>What did you get wrong?</h1>
              <p>Upload or paste a CFA question and let&apos;s break it down.</p>
            </section>
          ) : (
            <div className="message-list">
              {messages.map((message) =>
                message.role === "user" ? (
                  <article className="user-message-row" key={message.id}>
                    <div className="user-message">
                      {!!message.images?.length && (
                        <div className="sent-images">
                          {message.images.map((image) => (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img key={image.id} src={image.src} alt={image.name} />
                          ))}
                        </div>
                      )}
                      {message.text && <p>{message.text}</p>}
                    </div>
                  </article>
                ) : (
                  <article className="assistant-message" key={message.id}>
                    <div className="assistant-avatar">C</div>
                    <div className={`assistant-content ${message.error ? "assistant-error" : ""}`}>
                      <MarkdownMessage>{message.text ?? ""}</MarkdownMessage>
                    </div>
                  </article>
                ),
              )}
              {isThinking && (
                <div className="thinking-row" aria-label="CFA Tutor is thinking">
                  <div className="assistant-avatar">C</div>
                  <div className="thinking-dots"><span /><span /><span /></div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="composer-zone">
          <div className="composer-wrap">
            {!!images.length && (
              <div className="image-previews">
                {images.map((image) => (
                  <div className="image-preview" key={image.id}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={image.src} alt={`Preview of ${image.name}`} />
                    <button
                      onClick={() => {
                        setImages((current) => current.filter((item) => item.id !== image.id));
                        setAttachmentError("");
                      }}
                      aria-label={`Remove ${image.name}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="composer">
              <textarea
                ref={textareaRef}
                value={text}
                onChange={handleTextareaChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder="Paste a CFA question or describe what went wrong..."
                rows={1}
                aria-label="Message CFA Tutor"
              />
              <div className="composer-actions">
                <div className="left-actions">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                    multiple
                    hidden
                    onChange={(event) => {
                      if (event.target.files) void addFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  <button
                    className="attach-button"
                    onClick={() => fileInputRef.current?.click()}
                    aria-label="Attach images"
                    title="Attach images"
                  >
                    <span>+</span> Attach
                  </button>
                  <span className="paste-hint">or paste an image</span>
                </div>
                <button
                  className="send-button"
                  onClick={() => void sendMessage()}
                  disabled={!canSend}
                  aria-label="Send message"
                  title="Send message"
                >
                  ↑
                </button>
              </div>
            </div>
            <p className={`privacy-note ${attachmentError ? "attachment-error" : ""}`}>
              {attachmentError || "Images are sent for analysis and not stored · Enter to send, Shift + Enter for a new line"}
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
