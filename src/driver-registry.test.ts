import { describe, expect, it, vi } from "vitest";
import { DriverRegistry } from "./driver-registry.js";
import { MockDevice, MockDriver } from "./mock-device.js";
import type { DeckDevice, DeviceDriver } from "./device.js";

describe("DriverRegistry", () => {
  it("connects devices discovered by a registered driver", async () => {
    const registry = new DriverRegistry({ pollIntervalMs: 1_000_000 });
    registry.register(new MockDriver([new MockDevice("d1")]));

    await registry.start();

    expect(registry.listDevices()).toHaveLength(1);
    expect(registry.listDevices()[0]!.state).toBe("connected");
    await registry.stop();
  });

  it("does not throw when a driver's discover() rejects", async () => {
    const registry = new DriverRegistry({ pollIntervalMs: 1_000_000 });
    const failingDriver: DeviceDriver = {
      driverId: "failing",
      discover: () => Promise.reject(new Error("usb subsystem unavailable")),
    };
    registry.register(failingDriver);

    await expect(registry.start()).resolves.toBeUndefined();
    await registry.stop();
  });

  // A device plugin can now be installed from the UI into a daemon that is
  // already running (apps/daemon/src/plugin-install.ts), so its driver arrives
  // after start() and has to be brought up to where the others already are.
  it("discovers a driver registered after start(), without waiting for the next poll", async () => {
    const registry = new DriverRegistry({ pollIntervalMs: 1_000_000 });
    await registry.start();
    expect(registry.listDevices()).toHaveLength(0);

    registry.register(new MockDriver([new MockDevice("late")]));
    await registry.discoverOnce();

    expect(registry.listDevices()).toHaveLength(1);
    await registry.stop();
  });

  it("installs the watch() of a driver registered after start()", async () => {
    const registry = new DriverRegistry({ pollIntervalMs: 1_000_000 });
    await registry.start();

    // A watch-only driver reports nothing from discover(), so if its watcher is
    // never installed its device is never found at all — not late, but never.
    let announce: ((device: DeckDevice) => void) | undefined;
    registry.register({
      driverId: "watch-only",
      discover: async () => [],
      watch: (onFound) => {
        announce = onFound;
        return { dispose: () => {} };
      },
    });

    expect(announce).toBeDefined();
    announce!(new MockDevice("watched"));
    await vi.waitFor(() => expect(registry.listDevices()).toHaveLength(1));

    await registry.stop();
  });

  it("marks a polling-only device disconnected once discover() stops reporting it", async () => {
    const devices: DeckDevice[] = [new MockDevice("d1")];
    const pollingDriver: DeviceDriver = {
      driverId: "polling",
      discover: async () => devices,
    };
    const registry = new DriverRegistry({ pollIntervalMs: 10 });
    registry.register(pollingDriver);
    await registry.start();
    expect(registry.listDevices()[0]!.state).toBe("connected");

    devices.length = 0; // simulate unplug: driver no longer reports the device
    await registry.discoverOnce();

    const states = registry.listDevices().map((d) => d.state);
    expect(states[0]).not.toBe("connected");

    await registry.stop();
  });
});
