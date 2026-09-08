# CFA Tutor

CFA Tutor is a personal, AI-powered study assistant for reviewing CFA questions and concepts. It provides Chinese-first explanations while retaining the English terminology used on the CFA exam.

## Features

- Next.js App Router and TypeScript
- OpenAI Responses API
- Multimodal screenshot and question understanding
- OpenAI File Search and Vector Store curriculum retrieval
- Chinese-first CFA tutoring with important English terminology
- Markdown, tables, and KaTeX formula rendering
- Browser-session multi-turn context

## Environment setup

Copy `.env.example` to `.env.local` and configure these server-side values:

```bash
OPENAI_API_KEY=
CFA_VECTOR_STORE_ID=
```

Never commit `.env.local` or actual credentials.

## One-time curriculum ingestion

The curriculum source files are private and are not included in this repository. If you have your own authorized copies, place the ten expected PDFs in the parent workspace's `课程` directory using their original filenames, configure `OPENAI_API_KEY`, and run:

```bash
npm run ingest:curriculum
```

The command validates all ten PDFs, creates or safely reuses the project's OpenAI vector store, uploads only missing files, waits for indexing, and writes `CFA_VECTOR_STORE_ID` to the git-ignored `.env.local` file. It is deliberately separate from `npm run dev`, so PDFs are not uploaded when the application starts.

## Run locally

```bash
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

## Checks

```bash
npm run lint
npm run build
```
