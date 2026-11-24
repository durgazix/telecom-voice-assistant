import asyncio
import json

from dotenv import load_dotenv

from livekit import agents
from langchain_core.messages import ToolMessage
from livekit.agents import Agent, AgentServer, AgentSession, TurnHandlingOptions, inference
from livekit.plugins import langchain as lk_langchain

from config import settings
from langchain_agent import lauki_agent

_ = load_dotenv()


def _publish_dashboard_event(room, payload: dict) -> None:
    """Send tool and transcript metadata to the dashboard over the data channel."""
    try:
        loop = asyncio.get_running_loop()
        data = json.dumps(payload).encode("utf-8")
        loop.create_task(room.local_participant.publish_data(data, reliable=True, topic="lauki.events"))
    except Exception:
        return


def _is_tool_token(item: object) -> bool:
    """True for the (ToolMessage, metadata) pairs astream emits from the tools node."""
    return isinstance(item, tuple) and len(item) == 2 and isinstance(item[0], ToolMessage)


class SpeechOnlyGraph:
    """Wraps the graph so tool return values never reach TTS."""

    def __init__(self, graph: object) -> None:
        self._graph = graph

    def astream(self, *args: object, **kwargs: object):
        inner = self._graph.astream(*args, **kwargs)

        async def _filtered():
            async for item in inner:
                if not _is_tool_token(item):
                    yield item

        return _filtered()


class LaukiAgent(Agent):
    """Lauki Phones voice agent backed by a LangChain agent graph."""

    def __init__(self) -> None:
        super().__init__(
            instructions="You are the Lauki Phones customer support voice assistant.",
            llm=lk_langchain.LLMAdapter(graph=SpeechOnlyGraph(lauki_agent)),
        )


server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: agents.JobContext):
    session = AgentSession(
        stt=inference.STT(model="deepgram/nova-3", language="multi"),
        tts=inference.TTS(
            model="inworld/inworld-tts-2",
            voice="Ashley",
        ),
        turn_handling=TurnHandlingOptions(
            turn_detection=inference.TurnDetector(),
            endpointing={
                "mode": "fixed",
                "min_delay": 0.5,
                "max_delay": 6.0,
            },
        ),
    )

    @session.on("function_tools_executed")
    def _on_tools(ev) -> None:
        tools = []
        for call, output in ev.zipped():
            tools.append(
                {
                    "name": call.name,
                    "arguments": call.arguments,
                    "result": output.output,
                    "ok": not output.is_error,
                }
            )
        _publish_dashboard_event(
            ctx.room,
            {"type": "tool", "tools": tools},
        )

    @session.on("conversation_item_added")
    def _on_item(ev) -> None:
        item = ev.item
        role = getattr(item, "role", None)
        text = ""
        content = getattr(item, "content", None)
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            text = " ".join(part for part in content if isinstance(part, str))
        if role and text:
            _publish_dashboard_event(
                ctx.room,
                {"type": "transcript", "role": role, "text": text},
            )

    await session.start(agent=LaukiAgent(), room=ctx.room)

    await session.generate_reply(user_input="Greet the user as Lauki Phone's customer assistant and ask how you can help.")


if __name__ == "__main__":
    agents.cli.run_app(server)
