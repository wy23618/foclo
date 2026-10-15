// Limit native file I/O while keeping input order. On failure, finish the
// current batch before rejecting so a service queue cannot advance while
// reads from its failed query are still running. No later batch is started.
async function readInBatches(items, read) {
  const values = [];
  for (let offset = 0; offset < items.length; offset += 8) {
    const results = await Promise.all(
      items.slice(offset, offset + 8).map(async (item) => {
        try { return { ok: true, value: await read(item) }; }
        catch (error) { return { ok: false, error }; }
      }),
    );
    for (const result of results) {
      if (!result.ok) throw result.error;
      values.push(result.value);
    }
  }
  return values;
}
module.exports = { readInBatches };
