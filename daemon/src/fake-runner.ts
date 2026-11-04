
import type {
  Runner,
  RunnerEvent,
  StartOptions,
} from "../../codehands-contracts/src/runner.ts";

export class FakeRunner implements Runner {
  async *start(
    options: StartOptions
  ): AsyncIterable<RunnerEvent> {
    yield {
      sessionId: options.sessionId,
      seq: 1,
      type: "task.started",
      at: new Date().toISOString(),
      payload: {
        prompt: options.prompt,
        agent: options.agent,
        model: options.model,
      },
    };

    yield {
      sessionId: options.sessionId,
      seq: 2,
      type: "message",
      at: new Date().toISOString(),
      payload: {
        text: "Fake runner is processing the task",
      },
    };

    yield {
      sessionId: options.sessionId,
      seq: 3,
      type: "task.finished",
      at: new Date().toISOString(),
      payload: {
        success: true,
      },
    };
  }

  async stop(_sessionId: string): Promise<void> {}

  async *resume(
    sessionId: string,
    _prompt?: string
  ): AsyncIterable<RunnerEvent> {
    yield {
      sessionId,
      seq: 1,
      type: "message",
      at: new Date().toISOString(),
      payload: {
        text: "Fake runner resumed",
      },
    };
  }

  async diff(
    _sessionId: string
  ): Promise<{ patch: string; stat: string }> {
    return { patch: "", stat: "" };
  }

  async approve(
    _sessionId: string,
    _message: string
  ): Promise<{ branch: string; commit: string }> {
    return {
      branch: "fake-branch",
      commit: "fake-commit",
    };
  }

  async reject(_sessionId: string): Promise<void> {}
}
