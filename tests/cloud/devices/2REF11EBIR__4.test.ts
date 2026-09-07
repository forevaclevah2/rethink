import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2REF11EBIR__4'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '2REF11EBIR__4'
const META: Metadata = { modelId: MODEL_ID, modelName: '2REF11EBIR__4', swVersion: '1.0' }

// 2REF11EBIR__4 — LG LF21G6200S (US 3-door counter-depth, ADA).
// Truncated variant of the shared fridge layout: 65-byte status body, not 68.
//
// Frame structure (AABBDevice strips AA/len and cksum/BB before processAABB):
//   AA <len> 10 EB <65 status bytes> <cksum> BB    - initial-status push
//   AA <len> 10 EC <65 prev> <65 cur> <cksum> BB   - status delta (only `cur` is used)
//
// Status offsets (fridge_common.STATUS_FIELDS):
//   [1] fridge raw (F: 44-raw)  [2] freezer raw (F: 6-raw)  [3] express freeze 1=off 2=on
//   [7] door 0=closed 1=open    [8] unit 0=F 1=C            [13] convertible 0xFF = absent

// VERBATIM capture from the live appliance, 2026-09-07, in reply to the F0ED query.
// fridge=37°F (raw 7), freezer=-3°F (raw 9), express=off, door=closed, unit=F.
const STATUS_REAL =
    '0207090102020600000001FFFFFF00FFFF00FFFFFFFFFFFFFF02000101FF0000FF01FF6400' +
    'FFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078'

// The complete frame as it came off the wire, checksum 0x90 included.
const SAMPLE_REAL_INITIAL = buf('AA4710EB' + STATUS_REAL + '90BB')

function mutate(status: string, index: number, value: number) {
    const b = Buffer.from(status, 'hex')
    b[index] = value
    return b.toString('hex').toUpperCase()
}

// processData only validates the AA.. ..BB envelope, so a filler checksum is fine here.
const initial = (status: string) => buf('AA4710EB' + status + '00BB')

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe('2REF11EBIR__4', () => {
    test('start() sends the F0ED status query on the wire', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex').toUpperCase(), 'AA0EF0ED1211010000010400EBBB')
    })

    test('decodes the real 65-byte 10EB capture', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_REAL_INITIAL)

        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.fridge_setpoint, 37) // 44 - 7
        assert.equal(props.freezer_setpoint, -3) // 6 - 9
        assert.equal(props.door, 'OFF')
        assert.equal(props.express_freeze, 'OFF')
        assert.equal(props.sabbath_mode, 'OFF') // [14] = 0
        assert.equal(props.display_lock, 'OFF') // [10] = 1 -> unlocked
        assert.equal(props.water_filter, 6) // [6] raw
        assert.equal(props.fresh_air_filter, 2) // [4] raw
        assert.equal(props.craft_ice, 2) // [25] raw
    })

    test('sabbath mode on is reported', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', initial(mutate(STATUS_REAL, 14, 0x01)))
        assert.equal(ha.devices[DEVICE_ID].properties.sabbath_mode, 'ON')
    })

    test('control panel lock reports ON when locked', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', initial(mutate(STATUS_REAL, 10, 0x02)))
        assert.equal(ha.devices[DEVICE_ID].properties.display_lock, 'ON')
    })

    test('0xFF diagnostics are left unpublished rather than reported as 255', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', initial(mutate(mutate(STATUS_REAL, 6, 0xff), 25, 0xff)))
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.water_filter, undefined)
        assert.equal(props.craft_ice, undefined)
        assert.equal(props.fresh_air_filter, 2) // still present
    })

    test('every published component is read-only (no command_topic anywhere)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_REAL_INITIAL)
        const comps = ha.devices[DEVICE_ID].config!.components
        for (const [name, comp] of Object.entries(comps)) {
            assert.equal(
                (comp as Record<string, unknown>).command_topic,
                undefined,
                `${name} must not advertise a command topic while writes are unverified`,
            )
        }
    })

    test('a status body truncated below the diagnostics still publishes what it has', () => {
        const { ha, thinq } = makeDevice()
        const short = STATUS_REAL.slice(0, 40 * 2) // 40 bytes: craft_ice at [25] present, nothing past 39
        thinq.emit('data', buf('AA2C10EB' + short + '00BB'))
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.fridge_setpoint, 37)
        assert.equal(props.craft_ice, 2)
    })

    test('publishes Fahrenheit units for this US model', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_REAL_INITIAL)

        const comps = ha.devices[DEVICE_ID].config!.components
        assert.equal((comps.fridge_setpoint as Record<string, string>).unit_of_measurement, '°F')
        assert.equal((comps.freezer_setpoint as Record<string, string>).unit_of_measurement, '°F')
    })

    test('door open is reported', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', initial(mutate(STATUS_REAL, 7, 0x01)))
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'ON')
    })

    test('express freeze on is reported', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', initial(mutate(STATUS_REAL, 3, 0x02)))
        assert.equal(ha.devices[DEVICE_ID].properties.express_freeze, 'ON')
    })

    test('express freeze 0xFF (unsupported) is left unpublished, not faked as OFF', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', initial(mutate(STATUS_REAL, 3, 0xff)))
        assert.equal(ha.devices[DEVICE_ID].properties.express_freeze, undefined)
    })

    test('celsius unit flag switches the reported scale', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', initial(mutate(STATUS_REAL, 8, 0x01)))

        const comps = ha.devices[DEVICE_ID].config!.components
        assert.equal((comps.fridge_setpoint as Record<string, string>).unit_of_measurement, '°C')
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 1) // 8 - 7
    })

    test('10EC delta uses the current half', () => {
        const { ha, thinq } = makeDevice()
        const cur = mutate(STATUS_REAL, 7, 0x01) // door open in the CURRENT half only
        thinq.emit('data', buf('AA8810EC' + STATUS_REAL + cur + '00BB'))
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'ON')
    })

    test('a short/unknown frame is ignored rather than throwing', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('AA0610FF00BB'))
        assert.equal(ha.devices[DEVICE_ID], undefined)
    })
})
