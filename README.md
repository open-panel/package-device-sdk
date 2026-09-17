# @open-panel/device-sdk

The hardware-agnostic device abstraction at the heart of
[OpenPanel](https://github.com/open-panel/openPanel): the `DeckDevice`/
`DeviceDriver` interfaces every adapter implements, a connection state
machine with automatic reconnection, a driver registry for multi-driver
discovery, and a mock device so everything built on top of this package is
testable with zero physical hardware.

## Install

```bash
npm install @open-panel/device-sdk
```

## What's in here

- **`DeckDevice`** — the interface a concrete device adapter implements:
  `connect`/`disconnect`, `onEvent`, `setButtonImage`, and the optional
  `setButtonLabel`/`clearButtonImage`/`flush` capabilities.
- **`DeviceDriver`** — discovers and instantiates `DeckDevice`s for one
  hardware family (`discover()`, optional `watch()` for hot-plug).
- **`DeviceConnectionManager`** — wraps a single `DeckDevice` and enforces the
  `discovered → connecting → connected → disconnected → reconnecting`
  lifecycle, with exponential-backoff reconnection. A device failure here
  never throws out of the class — a USB device disappearing must not crash
  the host.
- **`DriverRegistry`** — holds every registered `DeviceDriver`, turns
  discovered devices into managed `DeviceConnectionManager`s, and exposes
  `onDeviceConnected`/`onDeviceDisconnected`/`onDeviceStateChanged`/
  `onDeviceEvent`. Adding a new device family is registering a driver here —
  nothing else in a host application needs to change.
- **`MockDevice` / `MockDriver`** — an in-memory fake device for tests and
  hardware-free development.

## Usage

Writing a driver for a new device family:

```ts
import type { DeckDevice, DeviceDriver } from "@open-panel/device-sdk";

class MyDevice implements DeckDevice {
  readonly id = "my-device-1";
  readonly info = { id: this.id, driverId: "my-driver", state: "discovered" /* ... */ };
  readonly capabilities = { /* ... */ };

  async connect() { /* open the physical connection */ }
  async disconnect() { /* close it */ }
  onEvent(listener) { /* subscribe to button presses */ return { dispose() {} }; }
  async setButtonImage(position, image) { /* write bytes to the device */ }
}

class MyDriver implements DeviceDriver {
  readonly driverId = "my-driver";
  async discover() {
    return [new MyDevice()];
  }
}
```

Wiring drivers into a host application:

```ts
import { DriverRegistry } from "@open-panel/device-sdk";

const registry = new DriverRegistry({ pollIntervalMs: 5000 });
registry.register(new MyDriver());

registry.onDeviceConnected((info) => console.log("connected", info.id));
await registry.start(); // runs one discovery pass and starts polling/watchers
```

## Related packages

- [`@open-panel/shared`](https://www.npmjs.com/package/@open-panel/shared) — the `DeviceInfo`/`DeviceEvent`/`DeviceCapabilities` types this package builds on
- [`@open-panel/plugin-sdk`](https://www.npmjs.com/package/@open-panel/plugin-sdk) — how a `DeviceDriver` is contributed from a plugin

## License

MIT © [OpenPanel contributors](https://github.com/open-panel/package-device-sdk/blob/main/LICENSE)
