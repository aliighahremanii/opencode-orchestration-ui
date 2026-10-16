// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useApi, useLiveChanges } from "../../components/client/use-api.ts";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("office observation lifecycle", () => {
  it("does not overlap polls or starve a slow read under repeated invalidations", async () => {
    vi.useFakeTimers();
    let resolveFirst!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue(new Response(JSON.stringify({ version: 2 }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const hook = renderHook(() => useApi<{ version: number }>("/api/office", { pollMs: 100 }));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { for (let index = 0; index < 10; index++) hook.result.current.refresh(); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { resolveFirst(new Response(JSON.stringify({ version: 1 }), { status: 200 })); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(hook.result.current.state).toEqual({ status: "ready", data: { version: 2 } });
  });

  it("cannot commit an obsolete request after the path changes", async () => {
    let resolveFirst!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue(new Response(JSON.stringify({ version: 2 }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const hook = renderHook(({ path }) => useApi<{ version: number }>(path), { initialProps: { path: "/api/office" } });
    await act(async () => { hook.rerender({ path: "/api/overview" }); });
    await act(async () => { resolveFirst(new Response(JSON.stringify({ version: 1 }), { status: 200 })); });
    expect(hook.result.current.state).toEqual({ status: "ready", data: { version: 2 } });
  });

  it("never opens a stream while disabled and cancels pending invalidation on hide", async () => {
    vi.useFakeTimers();
    const sources: EventTarget[] = [];
    class Source extends EventTarget { close = vi.fn(); constructor() { super(); sources.push(this); } }
    vi.stubGlobal("EventSource", Source);
    const refresh = vi.fn();
    const hook = renderHook(({ enabled }) => useLiveChanges(refresh, { enabled }), { initialProps: { enabled: false } });
    expect(sources).toHaveLength(0);
    hook.rerender({ enabled: true });
    act(() => { sources[0].dispatchEvent(new MessageEvent("change", { data: JSON.stringify({ seq: 10 }) })); });
    hook.rerender({ enabled: false });
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("stops reconnecting after auth-expired and invalidates the protected snapshot", async () => {
    vi.useFakeTimers();
    const sources: EventTarget[] = [];
    class Source extends EventTarget { close = vi.fn(); constructor() { super(); sources.push(this); } }
    vi.stubGlobal("EventSource", Source);
    const refresh = vi.fn();
    const hook = renderHook(({ enabled }) => useLiveChanges(refresh, { enabled }), { initialProps: { enabled: true } });
    act(() => { sources[0].dispatchEvent(new Event("auth-expired")); sources[0].dispatchEvent(new Event("error")); });
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(sources).toHaveLength(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(hook.result.current.authExpired).toBe(true);
    hook.rerender({ enabled: false });
    hook.rerender({ enabled: true });
    expect(sources).toHaveLength(1);
  });
});
