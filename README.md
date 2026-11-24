# Lauki Phones Voice Agent 🎙️📱

A real-time voice-based customer support agent for **Lauki Phones** — a fictional Indian telecom company. Customers speak to an AI assistant over a live audio stream that can look up account balances, answer plan questions using RAG over PDF docs, check network coverage, recommend plans, and escalate to human support.

The product UI is a **premium telecom support dashboard**. The voice worker is unchanged LiveKit + LangChain. The dashboard never reimplements plan, balance, or coverage logic.

Built with **LiveKit Agents**, **LangChain + Groq**, **Docling**, **Qdrant**, and a vanilla HTML/CSS/JS frontend.

---

## Getting Started

### Prerequisites

- Python `>= 3.12`
- [LiveKit Cloud](https://livekit.io/) credentials (URL, API Key, API Secret)
- [Groq](https://console.groq.com/keys) API Key

### Installation

```bash
# Install dependencies
uv sync  # or: pip install -e .

# Configure environment
cp .env.example .env
# Edit .env with your LiveKit and Groq credentials

# Activate virtual env (Windows PowerShell)
.venv\Scripts\Activate.ps1

# Ingest PDF documents into vector DB (once)
python ingest.py
```

### Run the dashboard

```bash
python -m uvicorn api_server:app --host 127.0.0.1 --port 8080
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080).

### Run the voice agent worker

The dashboard can request a LiveKit room token, but an agent only joins if this worker is running:

```bash
python -m voice_agent.main dev
```

Use `console` instead of `dev` for the original terminal-only voice mode.

---

## Example Prompts

| Try saying… | What happens |
|---|---|
| *"What plans do you offer?"* | Searches plan docs via RAG |
| *"What's the 5G coverage in Bangalore?"* | Returns network status by region |
| *"I want to speak to a human"* | Creates a support ticket and escalates |

---
Copyright©️ Codebasics Inc. All rights reserved.
