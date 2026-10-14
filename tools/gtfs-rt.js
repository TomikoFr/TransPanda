// Minimal GTFS-Realtime protobuf reader. The official schema is maintained at
// https://github.com/google/transit/blob/master/gtfs-realtime/proto/gtfs-realtime.proto
// Only VehiclePositions and their descriptors are decoded; unknown fields skip.
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_VEHICLES = 5000;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  varint(safeNumber = true) {
    let result = 0;
    for (let index = 0; index < 10; index++) {
      if (this.offset >= this.bytes.length) throw new Error('Truncated protobuf varint');
      const byte = this.bytes[this.offset++];
      if (index === 9 && byte > 1) throw new Error('Invalid protobuf varint');
      if (safeNumber) result += (byte & 127) * 2 ** (index * 7);
      if (!(byte & 128)) {
        if (safeNumber && !Number.isSafeInteger(result)) throw new Error('Unsafe protobuf integer');
        return result;
      }
    }
    throw new Error('Invalid protobuf varint');
  }

  take(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.bytes.length - this.offset) {
      throw new Error('Truncated protobuf field');
    }
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  nested(wire) {
    if (wire !== 2) throw new Error('Invalid protobuf field type');
    return new Reader(this.take(this.varint()));
  }

  string(wire) {
    const nested = this.nested(wire);
    if (nested.bytes.length > 2048) throw new Error('Protobuf identifier too long');
    return textDecoder.decode(nested.bytes);
  }

  integer(wire) {
    if (wire !== 0) throw new Error('Invalid protobuf integer type');
    return this.varint();
  }

  float(wire) {
    if (wire !== 5) throw new Error('Invalid protobuf float type');
    const offset = this.offset;
    this.take(4);
    return this.view.getFloat32(offset, true);
  }

  skip(wire) {
    if (wire === 0) this.varint(false);
    else if (wire === 1) this.take(8);
    else if (wire === 2) this.take(this.varint());
    else if (wire === 5) this.take(4);
    else throw new Error('Unsupported protobuf wire type');
  }

  fields(callback) {
    while (this.offset < this.bytes.length) {
      const tag = this.varint();
      const field = Math.floor(tag / 8);
      const wire = tag % 8;
      if (!field || field > 0x1fffffff) throw new Error('Invalid protobuf field number');
      callback(field, wire, this);
    }
  }
}

function header(reader) {
  let timestamp;
  reader.fields((field, wire, input) => {
    if (field === 3) timestamp = input.integer(wire);
    else input.skip(wire);
  });
  return timestamp;
}

function trip(reader) {
  const result = {};
  reader.fields((field, wire, input) => {
    if (field === 1) result.tripId = input.string(wire);
    else if (field === 5) result.routeId = input.string(wire);
    else input.skip(wire);
  });
  return result;
}

function descriptor(reader) {
  const result = {};
  reader.fields((field, wire, input) => {
    if (field === 1) result.id = input.string(wire);
    else if (field === 2) result.label = input.string(wire);
    else input.skip(wire);
  });
  return result;
}

function position(reader) {
  const result = {};
  reader.fields((field, wire, input) => {
    if (field === 1) result.lat = input.float(wire);
    else if (field === 2) result.lon = input.float(wire);
    else if (field === 3) result.bearing = input.float(wire);
    else input.skip(wire);
  });
  return result;
}

function vehicle(reader) {
  const result = {};
  reader.fields((field, wire, input) => {
    if (field === 1) Object.assign(result, trip(input.nested(wire)));
    else if (field === 2) Object.assign(result, position(input.nested(wire)));
    else if (field === 5) result.timestamp = input.integer(wire);
    else if (field === 8) Object.assign(result, descriptor(input.nested(wire)));
    else input.skip(wire);
  });
  return result;
}

function entity(reader) {
  let id = '', deleted = false, result;
  reader.fields((field, wire, input) => {
    if (field === 1) id = input.string(wire);
    else if (field === 2) deleted = Boolean(input.integer(wire));
    else if (field === 4) result = vehicle(input.nested(wire));
    else input.skip(wire);
  });
  if (!result || deleted) return null;
  return { ...result, id: result.id || id, label: result.label || result.id || id };
}

export function decodeVehicleFeed(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('Invalid protobuf feed size');
  const vehicles = [];
  let feedTimestamp, entityCount = 0;
  new Reader(bytes).fields((field, wire, input) => {
    if (field === 1) feedTimestamp = header(input.nested(wire));
    else if (field === 2) {
      if (++entityCount > 20000) throw new Error('Too many protobuf entities');
      const item = entity(input.nested(wire));
      if (item && item.id && Number.isFinite(item.lat) && Math.abs(item.lat) <= 90 &&
          Number.isFinite(item.lon) && Math.abs(item.lon) <= 180 && vehicles.length < MAX_VEHICLES) {
        vehicles.push({ ...item, routeId: item.routeId || '', tripId: item.tripId || '',
          bearing: Number.isFinite(item.bearing) && item.bearing >= 0 && item.bearing <= 360 ? item.bearing : null });
      }
    } else input.skip(wire);
  });
  return { feedTimestamp, vehicles };
}
