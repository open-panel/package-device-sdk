import { describe, expect, it, vi } from "vitest";
import { DeviceConnectionManager } from "./connection-manager.js";
import { MockDevice } from "./mock-device.js";
import type { DeckDevice } from "./device.js";

describe("DeviceConnectionManager", () => {
  it("transitions discovered -> connecting -> connected", async () => {
    const device = new MockDevice("d1");
    const states: string[] = [];
    const manager = new DeviceConnectionManager(device);
    manager.onStateChange((info) => states.push(info.state));

    await manager.connect();

    expect(states).toEqual(["connecting", "connected"]);
    expect(manager.info.state).toBe("connected");
  });

  // An adapter declares the pixels it wants and the host produces them
  // (apps/daemon/src/button-image.ts), so that no device plugin has to carry
  // an image library of its own.
  it("hands a device that declared an image format the encoded bytes, not the icon", async () => {
    const device = new MockDevice("d1", {
      buttonImage: { size: 64, encoding: "jpeg", quality: 90 },
    });
    const encodeButtonImage = vi.fn().mockResolvedValue(Buffer.from("encoded"));
    const manager = new DeviceConnectionManager(device, { encodeButtonImage });

    await manager.connect();
    await manager.setButtonImage(2, Buffer.from("the icon as stored"));

    expect(encodeButtonImage).toHaveBeenCalledWith({
      deviceId: "d1",
      position: 2,
      image: Buffer.from("the icon as stored"),
      format: { size: 64, encoding: "jpeg", quality: 90 },
    });
    expect(device.buttonImages.get(2)).toEqual(Buffer.from("encoded"));
  });

  it("passes the icon through untouched for a device that declared no format", async () => {
    const device = new MockDevice("d1");
    const encodeButtonImage = vi.fn();
    const manager = new DeviceConnectionManager(device, { encodeButtonImage });

    await manager.connect();
    await manager.setButtonImage(0, Buffer.from("raw"));

    expect(encodeButtonImage).not.toHaveBeenCalled();
    expect(device.buttonImages.get(0)).toEqual(Buffer.from("raw"));
  });

  it("asks for a blank frame when clearing, so an adapter needs no image code", async () => {
    // MockDevice implements no clearButtonImage — this needs one that does,
    // since the blank is only produced for a device that can use it.
    const base = new MockDevice("d1", { buttonImage: { size: 64, encoding: "jpeg" } });
    const cleared: (Buffer | undefined)[] = [];
    const device: DeckDevice = {
      ...base,
      id: base.id,
      info: base.info,
      capabilities: base.capabilities,
      connect: () => base.connect(),
      disconnect: () => base.disconnect(),
      onEvent: (listener) => base.onEvent(listener),
      setButtonImage: (position, image) => base.setButtonImage(position, image),
      clearButtonImage: async (_position, blank) => void cleared.push(blank),
    };
    const encodeButtonImage = vi.fn().mockResolvedValue(Buffer.from("black"));
    const manager = new DeviceConnectionManager(device, { encodeButtonImage });

    await manager.connect();
    await manager.clearButtonImage(1);

    // No `image`: that is what asks for a black frame in the device's format.
    expect(encodeButtonImage).toHaveBeenCalledWith({
      deviceId: "d1",
      position: 1,
      image: undefined,
      format: { size: 64, encoding: "jpeg" },
    });
    expect(cleared).toEqual([Buffer.from("black")]);
  });

  it("forwards normalized device events", async () => {
    const device = new MockDevice("d1");
    const manager = new DeviceConnectionManager(device);
    const received: number[] = [];
    manager.onDeviceEvent((event) => {
      if (event.type === "button.press") received.push(event.position);
    });

    await manager.connect();
    device.simulatePress(3);

    expect(received).toEqual([3]);
  });

  it("schedules reconnection after an unexpected disconnect and does not throw", async () => {
    vi.useFakeTimers();
    const device = new MockDevice("d1");
    const manager = new DeviceConnectionManager(device, {
      baseRetryDelayMs: 10,
      maxRetryDelayMs: 20,
    });
    const states: string[] = [];
    manager.onStateChange((info) => states.push(info.state));

    await manager.connect();
    manager.notifyDisconnected();

    expect(states).toContain("disconnected");
    expect(states).toContain("reconnecting");

    await vi.advanceTimersByTimeAsync(50);
    expect(manager.info.state).toBe("connected");

    manager.dispose();
    vi.useRealTimers();
  });

  it("does not throw when the underlying device rejects connect()", async () => {
    const device = new MockDevice("d1");
    device.connect = vi.fn().mockRejectedValue(new Error("usb gone"));
    const manager = new DeviceConnectionManager(device, { baseRetryDelayMs: 10_000 });

    await expect(manager.connect()).resolves.toBeUndefined();
    expect(manager.info.state).toBe("reconnecting");
    manager.dispose();
  });
});
