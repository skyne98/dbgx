// A deliberately complex TypeScript program to exercise dbgx:
//  - async/await + Promise.all (microtask concurrency)
//  - classes with inheritance
//  - generators / iterators
//  - closures capturing state
//  - Map/Set
//  - error handling (try/catch/finally + custom errors)
//  - a job queue with retry/backoff
//  - recursion (tree walk)

// ---- Custom error hierarchy ----
class AppError extends Error {
  constructor(message: string, public code: number) {
    super(message);
    this.name = "AppError";
  }
}
class TransientError extends AppError {
  constructor(message: string, code = 503) {
    super(message, code);
    this.name = "TransientError";
  }
}

// ---- Tree (recursion target) ----
interface TreeNode {
  id: number;
  label: string;
  children: TreeNode[];
}
function makeTree(depth: number, breadth: number, counter: { n: number }): TreeNode {
  const id = counter.n++;
  const node: TreeNode = { id, label: `node-${id}`, children: [] };
  if (depth > 0) {
    for (let i = 0; i < breadth; i++) {
      node.children.push(makeTree(depth - 1, breadth, counter));
    }
  }
  return node;
}
function countLeaves(node: TreeNode): number {
  if (node.children.length === 0) return 1;
  return node.children.reduce((acc, c) => acc + countLeaves(c), 0);
}
function* walk(node: TreeNode): Generator<TreeNode> {
  yield node;
  for (const c of node.children) yield* walk(c);
}

// ---- Async work with retry/backoff ----
class JobQueue {
  private attempts = new Map<number, number>();
  private done = new Set<number>();
  constructor(public maxRetries: number = 3) {}

  private async tryWork(jobId: number, work: () => Promise<number>): Promise<number> {
    const attempt = (this.attempts.get(jobId) ?? 0) + 1;
    this.attempts.set(jobId, attempt);
    if (attempt === 1 && jobId % 2 === 0) {
      // simulate a transient flake on even jobs' first attempt
      throw new TransientError(`flaky job ${jobId} attempt ${attempt}`);
    }
    return work();
  }

  async run(jobId: number, work: () => Promise<number>): Promise<number> {
    for (let tries = 0; tries < this.maxRetries; tries++) {
      try {
        const result = await this.tryWork(jobId, work);
        this.done.add(jobId);
        return result;
      } catch (e) {
        if (e instanceof TransientError && tries < this.maxRetries - 1) {
          // backoff (very short for the demo)
          await new Promise((r) => setTimeout(r, 10));
          continue;
        }
        throw e;
      }
    }
    throw new AppError(`exhausted retries for job ${jobId}`, 500);
  }

  stats() {
    return { attempted: this.attempts.size, done: this.done.size };
  }
}

// ---- A tiny LRU-ish cache using a Map ----
class Cache<K, V> {
  private store = new Map<K, V>();
  constructor(public capacity: number) {}
  get(k: K): V | undefined {
    const v = this.store.get(k);
    if (v !== undefined) {
      this.store.delete(k);
      this.store.set(k, v); // move to end (most-recent)
    }
    return v;
  }
  set(k: K, v: V): void {
    if (this.store.has(k)) this.store.delete(k);
    else if (this.store.size >= this.capacity) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(k, v);
  }
  size(): number { return this.store.size; }
}

// ---- Pipeline using generators + closures ----
function* pipeline<T>(src: T[], ...stages: ((x: T) => T)[]): Generator<T> {
  for (const item of src) {
    let v = item;
    for (const stage of stages) v = stage(v);
    yield v;
  }
}

async function main() {
  // 1. tree + recursion
  const counter = { n: 0 };
  const root = makeTree(3, 2, counter);
  const leaves = countLeaves(root);
  const walked = [...walk(root)].length;

  // 2. LRU cache
  const cache = new Cache<number, string>(3);
  cache.set(1, "a"); cache.set(2, "b"); cache.set(3, "c");
  cache.get(1);                       // touch 1
  cache.set(4, "d");                   // evicts 2
  const hit2 = cache.get(2);           // undefined (evicted)
  const hit1 = cache.get(1);           // "a"

  // 3. pipeline via generators + closures
  const double = (x: number) => x * 2;
  const addOne = (x: number) => x + 1;
  const pipe = pipeline([1, 2, 3], double, addOne);
  const piped: number[] = [...pipe];

  // 4. async job queue with retry
  const queue = new JobQueue(4);
  const jobWork = (id: number) => async (): Promise<number> => {
    await new Promise((r) => setTimeout(r, 5));
    return id * id;
  };
  const jobIds = [1, 2, 3, 4, 5, 6];
  const results: number[] = [];
  // run a few concurrently
  await Promise.all(
    jobIds.slice(0, 3).map(async (id) => {
      const r = await queue.run(id, jobWork(id));
      results.push(r);
    }),
  );
  // then the rest
  for (const id of jobIds.slice(3)) {
    const r = await queue.run(id, jobWork(id));
    results.push(r);
  }
  const stats = queue.stats();

  // 5. closure capturing the cache
  const cached = (k: number) => cache.get(k) ?? `<missing ${k}>`;
  const c1 = cached(1);

  console.log("leaves=", leaves, "walked=", walked);
  console.log("cache: hit2=", hit2, "hit1=", hit1, "size=", cache.size());
  console.log("piped=", piped);
  console.log("results=", results);
  console.log("queue stats=", stats);
  console.log("cached(1)=", c1);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
