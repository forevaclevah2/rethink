# 2REF11EBIR__4 — LG LF21G6200S (US 3-door counter-depth, ADA)

Support for a refrigerator model that reports a **65-byte status body** instead of
the 68 bytes `2REF11EIDA__4` expects. Everything else about the protocol is the
shared fridge layout.

## Why this file exists

If a future upstream change breaks this handler, this document should contain
enough to rebuild it from scratch without owning the appliance.

## The appliance

| | |
|---|---|
| Model | LG LF21G6200S, product code GV-B218HSNB.ASTCNA0 |
| Model ID (`meta.modelId`) | `2REF11EBIR__4` |
| DeviceType | 101 (refrigerator) |
| Platform | thinq2, protocolVer 2, AABB framing |
| Modem | RTK_RTL8720cm, `clip_ble_v1.9.196` |
| Firmware | `clip_v2.00.15.05-SDK-8-RELEASE` |

## How the status frame was obtained

The unit does **not** volunteer `10EB`/`10EC`. Left alone it only emits its own
telemetry — `100A` (523 B, changes constantly), plus static `10C5` (56 B),
`103E` (11 B), `1018` (10 B). Those are not the HA status block.

Sending the family-wide status query makes it answer in ~200 ms:

```
->  AA0EF0ED1211010000010400EBBB      (F0ED status request; this is what start() sends)
<-  AA4710EB0207090102020600...90BB   (10EB initial status, 71 B)
```

That is why `start()` must send the query. Drop it and the entities never populate.

### The capture, verbatim

```
AA4710EB0207090102020600000001FFFFFF00FFFF00FFFFFFFFFFFFFF02000101FF0000FF01FF64
00FFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF007890BB
```

- frame 71 B, declared length `0x47`
- checksum `0x90` — verifies as `(sum(bytes[:-2]) & 0xff) ^ 0x55`
- inner (after AA/len, before cksum/BB) = 67 B → status body = **65 B**

### Decoded

Field order is `fridge_common.STATUS_FIELDS`, same as `2REF11EIDA__4`:

| Idx | Field | Raw | Meaning |
|---|---|---|---|
| 1 | fridgeSetpoint | 7 | 37 °F (`44 - raw`) |
| 2 | freezerSetpoint | 9 | −3 °F (`6 - raw`) |
| 3 | expressFreeze | 1 | off (1=off, 2=on) |
| 7 | anyDoorOpen | 0 | closed |
| 8 | tempUnit | 0 | Fahrenheit |
| 10 | displayLock | 1 | unlocked |
| 13 | convertibleTemp | 0xFF | absent — 3-door has no flex drawer |

37 °F / −3 °F are LG's factory defaults, which is what makes this decode
trustworthy rather than a coincidence of offsets.

## Why the buffer is short, and why that is expected

`fridge_common.ts` already says it:

> These appear to be shared across various fridge models. **The buffer is
> truncated for lower-end models.**

`unpackStatus()` is written to tolerate it (`if (buf.length > index)`). The only
thing standing in the way was `2REF11EIDA__4.processAABB`, which matches on
`buf.length === 2 + 68` exactly and therefore silently drops a 67-byte inner.

This handler matches on a **range** instead of an exact length, so a firmware
update that pads or trims a byte degrades to "a field is missing" rather than
going completely silent.

## Read-only, deliberately

Reads are verified against the real appliance. **Writes are not.**

`2REF11EIDA__4` commands with an `F017` frame whose length (`0x69`) is sized for
its 68-byte layout. This model's write-frame length is unknown, and sending a
wrong-length `F017` to a refrigerator could silently move setpoints. So setpoints
are published as `sensor`, not `number`, and no command topics are advertised.

### Enabling control later

1. Change a setting on the fridge's own front panel.
2. Watch the add-on log for an `F017` frame emitted by the appliance.
3. Note its total length and which byte changed.
4. Only then port `setProperty` from `2REF11EIDA__4`, adjusting the template
   length to match what the appliance actually sends.

Do not guess the length.

## If upstream changes break this

Likely breakages, in order of probability:

1. **`fridge_common.STATUS_FIELDS` reordered** → the offset table above is the
   ground truth; re-derive indices from the field names.
2. **`AABBDevice.processData` changes its slicing** → it currently passes
   `buf.subarray(2, len-2)`, i.e. cmd bytes + body. `processAABB` assumes that.
3. **Discovery schema changes** → compare against a sibling like
   `2REF11EBIVPC4.ts`, which publishes the same component shapes.

The unit test (`tests/cloud/devices/2REF11EBIR__4.test.ts`) asserts against the
verbatim capture above, so a regression shows up as a failing test rather than a
silently empty device.

## Upstreaming

This is written to be upstreamable to `anszom/rethink` as-is. The frame capture
and decode table are the evidence a maintainer needs.
