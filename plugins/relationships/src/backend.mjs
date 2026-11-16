let context;
export function apply(value) {
  context = value;
}
export async function invoke(action, input) {
  if (action !== "arrange") throw new Error("未知动作。");
  const request = (action, input) =>
    context.request(action, { ...input, work_ref: context.work_ref });
  const recovered = await request("hetu.extensions.operations.get", {
    operation_key: input.operation_key,
  });
  if (recovered.status === "succeeded") return recovered;
  const read = await request("hetu.extensions.objects.get", {
    object_id: input.object_id,
  });
  if (read.status !== "succeeded") return read;
  const object = read.data.object;
  const nodes = object.content.nodes.map((node, index) => ({
    ...node,
    x: 150 + (index % 4) * 240,
    y: 110 + Math.floor(index / 4) * 150,
  }));
  return request("hetu.extensions.objects.save", {
    object_id: object.object_id,
    kind: object.kind,
    title: object.title,
    schema_version: object.schema_version,
    content: { ...object.content, nodes },
    expected_revision: object.revision,
    expected_sha256: read.data.sha256,
    operation_key: input.operation_key,
  });
}
