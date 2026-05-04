import type { PoBLuaApiClient } from "../pobLuaBridge.js";
import type { TreeService } from "../services/treeService.js";
import { wrapHandler } from "../utils/errorHandling.js";

export interface JewelHandlerContext {
  treeService: TreeService;
  getLuaClient: () => PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
}

const JEWEL_SLOT_PREFIX = "Jewel ";

interface JewelSocketEntry {
  node_id: number;
  node_name: string;
  is_cluster: boolean;
  current_jewel: { name: string; base?: string; rarity?: string } | null;
}

function parseNodeIdFromSlot(slotName: string): number | null {
  if (!slotName.startsWith(JEWEL_SLOT_PREFIX)) return null;
  const id = Number(slotName.slice(JEWEL_SLOT_PREFIX.length));
  return Number.isFinite(id) ? id : null;
}

function ensureLuaClient(context: JewelHandlerContext): PoBLuaApiClient {
  const luaClient = context.getLuaClient();
  if (!luaClient) {
    throw new Error("Lua client not initialized. Use lua_start first.");
  }
  return luaClient;
}

async function gatherJewelSockets(
  context: JewelHandlerContext,
  luaClient: PoBLuaApiClient
): Promise<JewelSocketEntry[]> {
  const tree = await luaClient.getTree();
  const allocatedIds = new Set<number>(
    Array.isArray(tree?.nodes) ? tree.nodes.map((n: any) => Number(n)) : []
  );
  const treeVersion: string = tree?.treeVersion || "3_26";
  const treeData = await context.treeService.getTreeData(treeVersion);

  const items = await luaClient.getItems();
  const sockets: JewelSocketEntry[] = [];
  for (const entry of items) {
    if (typeof entry?.slot !== "string") continue;
    const nodeId = parseNodeIdFromSlot(entry.slot);
    if (nodeId == null) continue;
    if (!allocatedIds.has(nodeId)) continue;

    const treeNode = treeData.nodes.get(String(nodeId));
    const nodeName = treeNode?.name || "Jewel Socket";
    const isCluster = nodeId >= 65536;

    const id = Number(entry.id);
    const hasItem = Number.isFinite(id) && id > 0;
    sockets.push({
      node_id: nodeId,
      node_name: nodeName,
      is_cluster: isCluster,
      current_jewel: hasItem
        ? {
            name: entry.name || "Unknown",
            base: entry.baseName || undefined,
            rarity: entry.rarity || undefined,
          }
        : null,
    });
  }

  sockets.sort((a, b) => a.node_id - b.node_id);
  return sockets;
}

function formatSocketLine(socket: JewelSocketEntry): string {
  const tag = socket.is_cluster ? " [cluster]" : "";
  const occupied = socket.current_jewel
    ? `${socket.current_jewel.rarity ? `${socket.current_jewel.rarity} ` : ""}${socket.current_jewel.name}`
    : "(empty)";
  return `- ${socket.node_id}: ${socket.node_name}${tag} → ${occupied}`;
}

export async function handleListJewelSockets(context: JewelHandlerContext) {
  return wrapHandler("list jewel sockets", async () => {
    await context.ensureLuaClient();
    const luaClient = ensureLuaClient(context);

    const sockets = await gatherJewelSockets(context, luaClient);

    if (sockets.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No allocated jewel sockets found on the active spec.",
          },
        ],
      };
    }

    const lines = sockets.map(formatSocketLine);
    const empty = sockets.filter((s) => s.current_jewel == null).length;
    const filled = sockets.length - empty;

    const text = [
      `Allocated jewel sockets: ${sockets.length} (${filled} filled, ${empty} empty)`,
      "",
      ...lines,
      "",
      `data:${JSON.stringify(sockets)}`,
    ].join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

function resolveSocketByName(
  sockets: JewelSocketEntry[],
  socketName: string
): JewelSocketEntry {
  const target = socketName.trim();
  if (target.length === 0) {
    throw new Error("socket_name cannot be empty");
  }
  const lower = target.toLowerCase();

  const exactMatches = sockets.filter(
    (s) => s.node_name.toLowerCase() === lower
  );
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) {
    const candidates = exactMatches
      .map((s) => `node_id=${s.node_id} (${s.node_name})`)
      .join(", ");
    throw new Error(
      `socket_name '${target}' matches ${exactMatches.length} sockets exactly. Disambiguate with socket_node_id. Candidates: ${candidates}`
    );
  }

  const substringMatches = sockets.filter((s) =>
    s.node_name.toLowerCase().includes(lower)
  );
  if (substringMatches.length === 1) return substringMatches[0];
  if (substringMatches.length === 0) {
    throw new Error(
      `socket_name '${target}' did not match any allocated jewel socket. Use list_jewel_sockets to see available sockets.`
    );
  }
  const candidates = substringMatches
    .map((s) => `node_id=${s.node_id} (${s.node_name})`)
    .join(", ");
  throw new Error(
    `socket_name '${target}' is ambiguous: matches ${substringMatches.length} sockets. Disambiguate with socket_node_id. Candidates: ${candidates}`
  );
}

export async function handleAddJewel(
  context: JewelHandlerContext,
  jewelText: string,
  socketNodeId?: number,
  socketName?: string
) {
  return wrapHandler("add jewel", async () => {
    if (!jewelText || jewelText.trim().length === 0) {
      throw new Error("jewel_text cannot be empty");
    }
    const hasNodeId = socketNodeId != null;
    const hasName = typeof socketName === "string" && socketName.trim().length > 0;
    if (hasNodeId === hasName) {
      throw new Error(
        "Provide exactly one of socket_node_id or socket_name (not both, not neither)."
      );
    }

    await context.ensureLuaClient();
    const luaClient = ensureLuaClient(context);

    const socketsBefore = await gatherJewelSockets(context, luaClient);

    let target: JewelSocketEntry;
    if (hasNodeId) {
      const id = Number(socketNodeId);
      if (!Number.isFinite(id)) {
        throw new Error(`socket_node_id ${socketNodeId} is not a valid integer`);
      }
      const match = socketsBefore.find((s) => s.node_id === id);
      if (!match) {
        throw new Error(
          `socket_node_id ${id} is not an allocated jewel socket on the active spec. Use list_jewel_sockets to see available sockets.`
        );
      }
      target = match;
    } else {
      target = resolveSocketByName(socketsBefore, socketName as string);
    }

    const slotName = JEWEL_SLOT_PREFIX + target.node_id;
    const wasReplacement = target.current_jewel != null;

    const returnedItem = await luaClient.addItem(jewelText, slotName);
    const returnedId = Number(returnedItem?.id);
    const returnedName = typeof returnedItem?.name === "string" ? returnedItem.name : null;

    const items = await luaClient.getItems();
    const postEntry = items.find(
      (e: any) => typeof e?.slot === "string" && e.slot === slotName
    );

    const postId = Number(postEntry?.id);
    const postName = typeof postEntry?.name === "string" ? postEntry.name : null;
    const postHasItem = postEntry != null && Number.isFinite(postId) && postId > 0;

    const idMatches =
      Number.isFinite(returnedId) && Number.isFinite(postId) && returnedId === postId;
    const nameMatches =
      returnedName != null && postName != null && returnedName === postName;

    if (!postHasItem || (!idMatches && !nameMatches)) {
      const slotState = postHasItem ? `now contains '${postName}'` : "is empty";
      throw new Error(
        `PoB validation rejected the jewel for socket ${target.node_id} (${target.node_name}). Likely cause: non-Jewel item text, charm/non-charm-socket mismatch, or cluster-jewel-size incompatibility. Slot ${slotState}.`
      );
    }

    const placedName = postName || returnedName || "Unknown";
    const verb = wasReplacement ? "replaced" : "placed";
    const previous = wasReplacement && target.current_jewel
      ? ` (was: ${target.current_jewel.name})`
      : "";
    const text = `Jewel ${verb} in socket ${target.node_id} (${target.node_name}): ${placedName}${previous}`;

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
      // Surface structured fields after the human-readable line for callers that parse output.
      structured: {
        node_id: target.node_id,
        node_name: target.node_name,
        slot: slotName,
        name: placedName,
        was_replacement: wasReplacement,
      },
    };
  });
}
