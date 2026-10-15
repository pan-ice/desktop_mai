export function createGlb() {
  const positions = new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0]);
  const bytes = Buffer.from(positions.buffer);
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0", generator: "Mai desktop test fixture" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [
        {
          doubleSided: true,
          pbrMetallicRoughness: {
            baseColorFactor: [0.6, 0.75, 0.5, 1],
            metallicFactor: 0,
            roughnessFactor: 1,
          },
        },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          min: [-0.5, 0, 0],
          max: [0.5, 1, 0],
        },
      ],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes.length }],
      buffers: [{ byteLength: bytes.length }],
    }),
  );
  const padded = Buffer.concat([
    json,
    Buffer.alloc((4 - (json.length % 4)) % 4, 32),
  ]);
  const result = Buffer.alloc(12 + 8 + padded.length + 8 + bytes.length);
  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(padded.length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(result, 20);
  result.writeUInt32LE(bytes.length, 20 + padded.length);
  result.writeUInt32LE(0x004e4942, 24 + padded.length);
  bytes.copy(result, 28 + padded.length);
  return result;
}
