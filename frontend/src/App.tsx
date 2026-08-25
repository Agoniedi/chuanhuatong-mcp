import {
  useState, useRef, useEffect, useCallback, useId,
  type CSSProperties, type ReactNode,
} from "react";
import { useApp } from "./store/useApp";
import { useRealtimeWS } from "./ws/useRealtimeWS";
import { applyBubbleColor, applyBubbleOpacity, readBubbleColor, readBubbleOpacity, readChatBackgroundUrl, saveChatBackground, selectChatBackgroundPreset } from "./appearance";
import { acceptInvite, deleteRoom, getWorldRoom, updateWorldRoom } from "./api/rooms";
import { leaveRoom, listMembers, removeRoomMember } from "./api/members";
import { listAgentBindings } from "./api/agent-bindings";
import { ApiError } from "./api/client";
import { changePassword, resetPassword } from "./api/auth";
import { listWorldRooms } from "./api/rooms";
import { markRoomRead, recallMessage, sendMessage } from "./api/messages";
import { isCurrentUserMessage } from "./messageIdentity";
import {
  createMcpDevice, deleteAgentProfile, listAgentProfiles, listDevices, revokeDevice,
  updateAgentProfile, updateMe, uploadAvatar,
} from "./api/profiles";
import type {
  AgentBinding, AgentProfile, Member as BackendMember,
  Message as BackendMessage, ProfileUpdatedEvent, Room as StoredRoom,
  RoomMembershipRemovedEvent,
  User, WsEvent, WorldRoom, McpDeviceCreation,
} from "./types";

/* ══════════════════════════════════════════════════════════
   TYPES
══════════════════════════════════════════════════════════ */

type Tab = "world" | "rooms" | "me";
type View =
  | { v: "chat"; room: Room }
  | { v: "profile" }
  | { v: "password" }
  | { v: "mcp" }
  | { v: "myai" }
  | { v: "appearance" };

interface Room {
  id: string; name: string; desc: string;
  lastMsg: string; lastTime: string; unread: number;
  members: number; ownerUserId?: string; ownerLabel: string; code: string;
  initials: string; color: string;
}
interface Msg {
  id: string; seq?: number; text: string; sender: string;
  isMe: boolean; isAI: boolean; time: string;
  initials: string; color: string; avatar?: string;
  replyTo?: { sender: string; text: string };
}
interface Member {
  id: string; name: string; handle: string;
  isAI: boolean;
  initials: string; color: string; role?: "owner" | "member";
  ownerUserId?: string;
  participationMode?: AgentBinding["participationMode"];
}

type BackendRoom = StoredRoom;

const C = {
  brand:  "#8A6B4F",
  green:  "#6FBF6C",
  orange: "#E0A24A",
  blue:   "#5F6DB5",
  red:    "#D35C4D",
  purple: "#8E7CC3",
};

const palette = [C.brand, C.purple, C.orange, C.green, C.red, C.blue];

function colorFor(value: string) {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

function initialsFor(value: string) {
  return value.trim().slice(0, 2) || "群";
}

function clockLabel(value: string | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function toUiRoom(room: BackendRoom): Room {
  return {
    id: room.id,
    name: room.title,
    desc: room.worldSummary || "传话筒群聊房间",
    lastMsg: "",
    lastTime: clockLabel(room.updatedAt),
    unread: room.unreadCount,
    members: room.memberCount ?? 0,
    ownerUserId: room.ownerUserId,
    ownerLabel: room.ownerUserId,
    code: "",
    initials: initialsFor(room.title),
    color: colorFor(room.id),
  };
}

function toWorldRoom(room: WorldRoom): Room {
  return {
    id: room.id,
    name: room.title,
    desc: room.summary || "公开讨论房间",
    lastMsg: "",
    lastTime: clockLabel(room.publishedAt),
    unread: 0,
    members: room.memberCount ?? 0,
    ownerLabel: room.ownerDisplayName,
    code: "",
    initials: initialsFor(room.title),
    color: colorFor(room.id),
  };
}

function messageText(message: BackendMessage) {
  return message.content.type === "text" ? message.content.text : "[不支持的消息类型]";
}

function toUiMessage(message: BackendMessage, currentUserId: string, replyMessage?: BackendMessage): Msg {
  const sender = message.sender.displayNameSnapshot;
  return {
    id: message.id,
    seq: message.seq,
    text: message.recalledAt ? "这条消息已撤回" : messageText(message),
    sender,
    isMe: isCurrentUserMessage(message.sender, currentUserId),
    isAI: message.sender.kind === "agent",
    time: clockLabel(message.createdAt),
    initials: initialsFor(sender),
    color: colorFor(message.sender.userId),
    avatar: message.sender.avatarResourceIdSnapshot
      ? `/v1/profile-resources/${encodeURIComponent(message.sender.avatarResourceIdSnapshot)}`
      : undefined,
    replyTo: replyMessage ? {
      sender: replyMessage.sender.displayNameSnapshot,
      text: replyMessage.recalledAt ? "消息已撤回" : messageText(replyMessage),
    } : undefined,
  };
}

function highlightedText(text: string) {
  return text.split(/(@[\p{L}\p{N}_-]+)/gu).map((part, index) =>
    part.startsWith("@")
      ? <mark key={`${part}-${index}`} style={{ color:"var(--brand)", background:"rgba(138,107,79,.14)", borderRadius:4, padding:"0 2px" }}>{part}</mark>
      : part,
  );
}

/* ══════════════════════════════════════════════════════════
   AVATAR PHOTOS
══════════════════════════════════════════════════════════ */
const AVATAR_XIAOCHA = "https://images.unsplash.com/photo-1775701663209-e177013c390f?crop=entropy&cs=tinysrgb&fit=crop&fm=jpg&h=80&w=80&q=80";
const AVATAR_ME      = "https://images.unsplash.com/photo-1522598829964-8453b2654632?crop=entropy&cs=tinysrgb&fit=crop&fm=jpg&h=80&w=80&q=80";

/* ══════════════════════════════════════════════════════════
   MOCK DATA
══════════════════════════════════════════════════════════ */
const MY_ROOMS: Room[] = [
  { id:"r1", name:"产品设计",  desc:"一起讨论产品方向与体验",
    lastMsg:"Nova：这个方案很不错", lastTime:"10:42", unread:3,
    members:12, ownerLabel:"李明", code:"PDX-2024", initials:"产", color:C.purple },
  { id:"r2", name:"AI 研究",   desc:"探索大语言模型的最新进展",
    lastMsg:"你：这篇论文值得一读", lastTime:"昨天", unread:0,
    members:8, ownerLabel:"你", code:"AIR-8832", initials:"研", color:C.orange },
  { id:"r3", name:"日常闲聊",  desc:"随便聊聊，放松一下",
    lastMsg:"陈晓：今天天气真好啊", lastTime:"周二", unread:0,
    members:5, ownerLabel:"王芳", code:"CHAT-5519", initials:"聊", color:C.green },
  { id:"r4", name:"前端开发",  desc:"技术分享与问题讨论",
    lastMsg:"Cody：试试 React 19 的新特性吧", lastTime:"周一", unread:7,
    members:24, ownerLabel:"张伟", code:"FED-0721", initials:"前", color:C.red },
];

const WORLD_ROOMS: Room[] = [
  { id:"w1", name:"AI 爱好者",   desc:"聚集对人工智能感兴趣的朋友们",
    lastMsg:"", lastTime:"", unread:0, members:1240, ownerLabel:"Alex Chen",
    code:"AI-FANS", initials:"爱", color:C.brand },
  { id:"w2", name:"创业者茶馆", desc:"创业路上互相交流，寻找志同道合",
    lastMsg:"", lastTime:"", unread:0, members:843, ownerLabel:"Maya Liu",
    code:"STARTUP", initials:"创", color:C.orange },
  { id:"w3", name:"读书俱乐部", desc:"每月共读一本书，一起慢慢成长",
    lastMsg:"", lastTime:"", unread:0, members:412, ownerLabel:"小字",
    code:"BOOK-R", initials:"读", color:C.blue },
  { id:"w4", name:"摄影爱好者", desc:"分享你的作品，交流拍摄技巧",
    lastMsg:"", lastTime:"", unread:0, members:677, ownerLabel:"镜头里的世界",
    code:"PHOTO1", initials:"摄", color:C.purple },
  { id:"w5", name:"健身打卡",   desc:"互相监督，坚持运动，过健康生活",
    lastMsg:"", lastTime:"", unread:0, members:289, ownerLabel:"运动达人",
    code:"FIT365", initials:"健", color:C.red },
];

const XIAOCHA_MSGS: Msg[] = [
  { id:"m1", text:"最近怎么样呀？", sender:"小茶",
    isMe:false, isAI:false, time:"16:30", initials:"茶", color:C.orange, avatar:AVATAR_XIAOCHA },
  { id:"m2", text:"挺好的，今天喝到很好喝的一杯茶，推荐给你～",
    sender:"你", isMe:true, isAI:false, time:"16:32", initials:"你", color:C.brand, avatar:AVATAR_ME },
  { id:"m3", text:"好呀，下次一起去喝～",
    sender:"小茶", isMe:false, isAI:false, time:"16:33", initials:"茶", color:C.orange, avatar:AVATAR_XIAOCHA },
  { id:"m4", text:"嗯嗯，找个周末吧！",
    sender:"你", isMe:true, isAI:false, time:"16:34", initials:"你", color:C.brand, avatar:AVATAR_ME },
  { id:"m5", text:"🤎",
    sender:"小茶", isMe:false, isAI:false, time:"16:35", initials:"茶", color:C.orange, avatar:AVATAR_XIAOCHA },
];

const INIT_MSGS: Msg[] = [
  { id:"m1", text:"大家好，我们来聊聊新版本的设计方向吧",
    sender:"李明", isMe:false, isAI:false, time:"10:30", initials:"李", color:C.purple },
  { id:"m2", text:"我觉得可以参考 iOS 信息 App 的设计语言，简洁直观",
    sender:"你", isMe:true, isAI:false, time:"10:31", initials:"你", color:C.brand },
  { id:"m3", text:"基于大家的方向，我分析了一些数据：78% 的用户更倾向简洁界面，建议优先考虑可读性和操作效率。",
    sender:"Nova", isMe:false, isAI:true, time:"10:32", initials:"N", color:C.orange },
  { id:"m4", text:"Nova 说得有道理，用户体验确实要放在第一位",
    sender:"陈晓", isMe:false, isAI:false, time:"10:35", initials:"陈", color:C.green },
  { id:"m5", text:"那就定下来，以简洁为主，功能为辅",
    sender:"你", isMe:true, isAI:false, time:"10:38", initials:"你", color:C.brand },
  { id:"m6", text:"颜色建议使用温暖的棕色调，和品牌保持一致，用户会更有亲切感。",
    sender:"Nova", isMe:false, isAI:true, time:"10:42", initials:"N", color:C.orange },
];

const AI_AGENTS = [
  { id:"a1", name:"Nova", desc:"数据分析与用户研究", initials:"N", color:C.orange, active:true },
  { id:"a2", name:"Cody", desc:"代码审查与技术文档", initials:"C", color:C.red,    active:true },
  { id:"a3", name:"Aria", desc:"写作与内容创作助理", initials:"A", color:C.purple, active:false },
];

const MCP_LIST = [
  { id:"d1", name:"MacBook Pro",   on:true,  seen:"刚刚",   token:"mcp_••••9f2a" },
  { id:"d2", name:"iPhone 15 Pro", on:true,  seen:"5 分钟前", token:"mcp_••••3b7c" },
  { id:"d3", name:"iPad Air",      on:false, seen:"3 天前",  token:"mcp_••••e51d" },
];

// 旧设计样例仅保留作迁移参考；运行时数据全部来自 REST / WebSocket。
void MY_ROOMS;
void WORLD_ROOMS;
void XIAOCHA_MSGS;
void INIT_MSGS;
void AI_AGENTS;
void MCP_LIST;

/* ══════════════════════════════════════════════════════════
   ICONS  (inline SVG)
══════════════════════════════════════════════════════════ */
const IC = {
  globe: (stroke: string, w = 1.6) => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke={stroke} strokeWidth={w}/>
      <ellipse cx="12" cy="12" rx="3.5" ry="9" stroke={stroke} strokeWidth={w}/>
      <path d="M3 12h18M4.5 8h15M4.5 16h15" stroke={stroke} strokeWidth={w} strokeLinecap="round"/>
    </svg>
  ),
  chat: (stroke: string, w = 1.6) => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
        stroke={stroke} strokeWidth={w} strokeLinejoin="round"/>
      <circle cx="9" cy="10" r="1" fill={stroke}/>
      <circle cx="12" cy="10" r="1" fill={stroke}/>
      <circle cx="15" cy="10" r="1" fill={stroke}/>
    </svg>
  ),
  person: (stroke: string, w = 1.6) => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="8" r="4" stroke={stroke} strokeWidth={w}/>
      <path d="M4 20c0-4.42 3.58-8 8-8s8 3.58 8 8" stroke={stroke} strokeWidth={w} strokeLinecap="round"/>
    </svg>
  ),
  back: () => (
    <svg width="10" height="17" viewBox="0 0 10 17" fill="none">
      <path d="M8.5 1.5L1.5 8.5l7 7" stroke="var(--brand)" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  chevron: () => (
    <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
      <path d="M1 1l5 5-5 5" stroke="var(--text-3)" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  plus: (stroke = "var(--brand)") => (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M9 2v14M2 9h14" stroke={stroke} strokeWidth="2" strokeLinecap="round"/>
    </svg>
  ),
  search: (stroke = "var(--text-3)") => (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <circle cx="7.5" cy="7.5" r="5.5" stroke={stroke} strokeWidth="1.6"/>
      <path d="M12 12l4 4" stroke={stroke} strokeWidth="1.6" strokeLinecap="round"/>
    </svg>
  ),
  moon: (stroke = "var(--text-3)") => (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M16 11.5A7.5 7.5 0 017.5 2a8 8 0 100 14A7.5 7.5 0 0116 11.5z"
        stroke={stroke} strokeWidth="1.6" strokeLinejoin="round"/>
    </svg>
  ),
  sun: (stroke = "var(--text-3)") => (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <circle cx="9" cy="9" r="3.5" stroke={stroke} strokeWidth="1.6"/>
      <path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M14.3 3.7l-1.4 1.4M5.1 12.9l-1.4 1.4"
        stroke={stroke} strokeWidth="1.6" strokeLinecap="round"/>
    </svg>
  ),
  copy: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="var(--brand)" strokeWidth="1.4"/>
      <path d="M3 10.5V3.5h7" stroke="var(--brand)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  dots: () => (
    <svg width="22" height="6" viewBox="0 0 22 6" fill="none">
      <circle cx="3" cy="3" r="2.2" fill="var(--text-3)"/>
      <circle cx="11" cy="3" r="2.2" fill="var(--text-3)"/>
      <circle cx="19" cy="3" r="2.2" fill="var(--text-3)"/>
    </svg>
  ),
  members: () => (
    <svg width="22" height="18" viewBox="0 0 22 18" fill="none">
      <circle cx="7" cy="5.5" r="3" stroke="var(--brand)" strokeWidth="1.5"/>
      <circle cx="15" cy="5.5" r="3" stroke="var(--brand)" strokeWidth="1.5"/>
      <path d="M1 17c0-3.31 2.69-6 6-6" stroke="var(--brand)" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M9 17c0-2.76 2.69-5 6-5s6 2.24 6 5" stroke="var(--brand)" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
  check2: () => (
    <svg width="16" height="10" viewBox="0 0 16 10" fill="none">
      <path d="M1 5l3 4L9.5 1" stroke="var(--text-3)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M6.5 5l3 4L16 1" stroke="var(--text-3)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
};

/* ══════════════════════════════════════════════════════════
   ATOMS
══════════════════════════════════════════════════════════ */

function PhotoAvi({ src, ch, color, size = 36 }: { src?: string; ch: string; color: string; size?: number }) {
  const [err, setErr] = useState(false);
  if (src && !err) {
    return (
      <img src={src} alt={ch} onError={() => setErr(true)}
        style={{ width:size, height:size, borderRadius:size/2, objectFit:"cover", flexShrink:0 }}/>
    );
  }
  return <Avi ch={ch} color={color} size={size}/>;
}

function Avi({ ch, color, size = 44 }: { ch: string; color: string; size?: number }) {
  return (
    <div style={{
      width:size, height:size, borderRadius:size/2,
      background:color, color:"#fff", flexShrink:0,
      display:"flex", alignItems:"center", justifyContent:"center",
      fontSize:Math.round(size * 0.4), fontWeight:600, letterSpacing:"-.01em",
    }}>{ch}</div>
  );
}

function AITag() {
  return (
    <span style={{
      fontSize:10, fontWeight:600, letterSpacing:".03em",
      color:"var(--ai-text)", background:"var(--ai-bg)",
      borderRadius:4, padding:"1px 5px", lineHeight:1.6,
    }}>AI</span>
  );
}

function Dot({ on }: { on: boolean }) {
  return (
    <div style={{
      width:8, height:8, borderRadius:4, flexShrink:0,
      background: on ? "var(--success)" : "var(--text-3)", opacity: on ? 1 : .4,
    }}/>
  );
}

function SepL() { return <div style={{ height:.5, background:"var(--sep)", marginLeft:16 }}/>; }

function SecLabel({ label }: { label: string }) {
  return (
    <div style={{
      fontSize:13, color:"var(--text-3)", fontWeight:400,
      padding:"20px 20px 6px", textTransform:"uppercase", letterSpacing:".04em",
    }}>{label}</div>
  );
}

/* Card container — 16px radius, spec shadow */
function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{
      background:"var(--surface)",
      borderRadius:"var(--card-r)",
      boxShadow:"var(--card-shadow)",
      overflow:"hidden",
      ...style,
    }}>{children}</div>
  );
}

function confirmErrorMessage(error: unknown) {
  if (!(error instanceof ApiError)) return "操作失败，请重试";
  if (error.code === "forbidden") return "你没有执行此操作的权限";
  if (error.code === "room_owner_cannot_leave") return "房主不能直接退出，请解散房间";
  if (error.code === "room_owner_cannot_be_removed") return "不能将房主踢出房间";
  if (error.code === "resource_not_found") return "目标已不存在，请刷新后重试";
  if (error.code === "request_version_conflict" || error.code === "conflict") {
    return "数据已更新，请刷新后重试";
  }
  return "操作失败，请重试";
}

function ConfirmDialog({ title, message, confirmLabel, onCancel, onConfirm }: {
  title: string;
  message: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    cancelButtonRef.current?.focus();
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div role="presentation" onClick={busy ? undefined : onCancel} style={{
      position:"fixed", inset:0, zIndex:300, background:"rgba(0,0,0,.32)",
      display:"grid", placeItems:"center", padding:24,
    }}>
      <div ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby={titleId}
        onKeyDown={handleKeyDown} onClick={event => event.stopPropagation()} className="anim-fade-up" style={{
          width:"100%", maxWidth:340, borderRadius:18, background:"var(--surface)",
          boxShadow:"0 18px 48px rgba(0,0,0,.22)", overflow:"hidden",
        }}>
        <div style={{ padding:"22px 22px 18px", textAlign:"center" }}>
          <div id={titleId} style={{ fontSize:18, fontWeight:700, color:"var(--text)" }}>{title}</div>
          <div style={{ marginTop:9, fontSize:14, lineHeight:1.6, color:"var(--text-2)" }}>{message}</div>
          {error && <div role="alert" style={{ marginTop:10, fontSize:13, color:"var(--danger)" }}>{error}</div>}
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", borderTop:".5px solid var(--sep)" }}>
          <button ref={cancelButtonRef} type="button" onClick={onCancel} disabled={busy} style={{
            minHeight:48, border:0, borderRight:".5px solid var(--sep)",
            background:"transparent", color:"var(--text-2)", fontSize:16, cursor:"pointer",
          }}>取消</button>
          <button type="button" onClick={() => {
            if (busy) return;
            setBusy(true); setError(null);
            void onConfirm().catch(error => {
              setError(confirmErrorMessage(error));
              setBusy(false);
            });
          }} disabled={busy} style={{
            minHeight:48, border:0, background:"transparent", color:"var(--danger)",
            fontSize:16, fontWeight:600, cursor:"pointer",
          }}>{busy ? "处理中..." : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  label: string; sub?: string; value?: string;
  left?: ReactNode; right?: ReactNode;
  danger?: boolean; noArrow?: boolean;
  style?: CSSProperties; onClick?: () => void;
}
function Row({ label, sub, value, left, right, danger, noArrow, style, onClick }: RowProps) {
  return (
    <div className={onClick ? "tap" : ""} onClick={onClick}
      style={{ display:"flex", alignItems:"center", padding:"13px 16px", minHeight:50, gap:12, ...style }}>
      {left}
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:16, color: danger ? "var(--danger)" : "var(--text)" }}>{label}</div>
        {sub && <div style={{ fontSize:13, color:"var(--text-2)", marginTop:2 }}>{sub}</div>}
      </div>
      {value && <span style={{ fontSize:14, color:"var(--text-3)", marginRight:4 }}>{value}</span>}
      {right}
      {onClick && !noArrow && !right && <IC.chevron/>}
    </div>
  );
}

function FieldRow({ label, type="text", placeholder, value, onChange }: {
  label: string; type?: string; placeholder?: string;
  value: string; onChange: (v: string) => void;
}) {
  return (
    <div style={{ display:"flex", alignItems:"center", padding:"13px 16px", gap:12 }}>
      <span style={{ fontSize:15, color:"var(--text)", width:80, flexShrink:0 }}>{label}</span>
      <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
        aria-label={label}
        style={{ flex:1, border:"none", outline:"none", background:"transparent",
          fontSize:15, color:"var(--text)", textAlign:"right" }}/>
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="tap" onClick={() => onChange(!on)} style={{
      width:50, height:30, borderRadius:15, flexShrink:0,
      background: on ? "var(--success)" : "rgba(142,142,147,.35)",
      position:"relative", transition:"background .2s",
    }}>
      <div style={{
        position:"absolute", top:3, left: on ? 23 : 3,
        width:24, height:24, borderRadius:12, background:"#fff",
        boxShadow:"0 1px 4px rgba(0,0,0,.25)", transition:"left .2s",
      }}/>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   LAYOUT SHELLS
══════════════════════════════════════════════════════════ */

function PageShell({ title, right, children, navPad = true }: {
  title: string; right?: ReactNode; children: ReactNode; navPad?: boolean;
}) {
  return (
    <div className="anim-fade-up" style={{ display:"flex", flexDirection:"column", height:"100%", background:"var(--grouped)" }}>
      {/* iOS 26-style large title — no hard bottom border, translucent on scroll */}
      <div style={{ padding:`${navPad ? "max(12px, var(--safe-top))" : "12px"} 20px 10px`, flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"flex-end", justifyContent:"space-between" }}>
          <h1 style={{ margin:0, fontSize:34, fontWeight:700, letterSpacing:"-.03em", color:"var(--text)" }}>
            {title}
          </h1>
          {right && <div style={{ paddingBottom:4 }}>{right}</div>}
        </div>
      </div>
      <div style={{ flex:1, overflowY:"auto", paddingBottom:24 }}>
        {children}
      </div>
    </div>
  );
}

/* Sub-page — slides over as overlay, iOS nav-bar style */
function SubShell({ title, onBack, right, children }: {
  title: string; onBack: () => void; right?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="anim-slide-r" style={{
      position:"absolute", inset:0, background:"var(--grouped)",
      display:"flex", flexDirection:"column", zIndex:20,
    }}>
      {/* iOS 26: frameless navbar with blur */}
      <div style={{
        padding:"max(8px, var(--safe-top)) 16px 8px",
        backdropFilter:"blur(24px) saturate(1.6)",
        WebkitBackdropFilter:"blur(24px) saturate(1.6)",
        background:"var(--blur-surface)",
        display:"flex", alignItems:"center", gap:8, flexShrink:0,
      }}>
        <button type="button" onClick={onBack} className="tap" aria-label="返回" style={{
          background:"none", border:"none", cursor:"pointer",
          padding:"4px 12px 4px 0", display:"flex", alignItems:"center",
        }}>
          <IC.back/>
        </button>
        <span style={{ flex:1, textAlign:"center", fontSize:17, fontWeight:600, color:"var(--text)" }}>
          {title}
        </span>
        <div style={{ width:44, display:"flex", justifyContent:"flex-end" }}>{right}</div>
      </div>
      <div style={{ flex:1, overflowY:"auto", paddingBottom:16 }}>
        {children}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   BOTTOM NAV  — iOS 26 floating liquid-glass pill
══════════════════════════════════════════════════════════ */

function BottomNav({ tab, setTab, unread }: {
  tab: Tab; setTab: (t: Tab) => void; unread: number;
}) {
  type NavItem = { id: Tab; label: string };
  const items: NavItem[] = [
    { id:"world", label:"世界" },
    { id:"rooms", label:"房间" },
    { id:"me",    label:"我"   },
  ];

  const iconFor = (id: Tab, active: boolean) => {
    const col = active ? "var(--brand)" : "var(--text-3)";
    const w   = active ? 2 : 1.6;
    if (id === "world") return IC.globe(col, w);
    if (id === "rooms") return IC.chat(col, w);
    return IC.person(col, w);
  };

  return (
    <div data-testid="bottom-nav" style={{
      position:"absolute", bottom:`max(8px, var(--safe-bottom))`,
      left:16, right:16, zIndex:100,
      display:"flex",
      background:"var(--nav-surface)",
      backdropFilter:"blur(28px) saturate(1.8)",
      WebkitBackdropFilter:"blur(28px) saturate(1.8)",
      borderRadius:36,
      boxShadow:"0 4px 24px rgba(45,36,28,.12), 0 0 0 .5px rgba(138,107,79,.18)",
      padding:"6px 8px",
    }}>
      {items.map(item => {
        const active = tab === item.id;
        return (
          <button key={item.id} onClick={() => setTab(item.id)} style={{
            flex:1, border:"none", cursor:"pointer",
            display:"flex", flexDirection:"column", alignItems:"center",
            justifyContent:"center", gap:3, padding:"8px 4px 6px",
            position:"relative",
            background: active ? "rgba(138,107,79,.12)" : "transparent",
            borderRadius:28,
            transition:"background .2s",
          }}>
            {/* Unread badge */}
            {item.id === "rooms" && unread > 0 && (
              <div style={{
                position:"absolute", top:6, right:"calc(50% - 18px)",
                background:"var(--danger)", color:"#fff",
                borderRadius:8, minWidth:16, height:16,
                fontSize:10, fontWeight:700, padding:"0 4px",
                display:"flex", alignItems:"center", justifyContent:"center",
              }}>{unread > 9 ? "9+" : unread}</div>
            )}
            {iconFor(item.id, active)}
            <span style={{
              fontSize:10, fontWeight: active ? 600 : 400,
              color: active ? "var(--brand)" : "var(--text-3)",
              letterSpacing:.2,
            }}>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   WORLD
══════════════════════════════════════════════════════════ */

function World({ rooms, onJoined, joined, onSheetOpenChange }: {
  rooms: Room[];
  onJoined: (room: Room, inviteToken?: string | null) => Promise<void>;
  joined: Set<string>;
  onSheetOpenChange?: (open: boolean) => void;
}) {
  const [sheet, setSheet] = useState<Room | null>(null);
  const [q, setQ] = useState("");
  const { state } = useApp();

  useEffect(() => () => onSheetOpenChange?.(false), [onSheetOpenChange]);

  const openSheet = (room: Room) => {
    setSheet(room);
    onSheetOpenChange?.(true);
  };

  const closeSheet = () => {
    setSheet(null);
    onSheetOpenChange?.(false);
  };

  const list = rooms.filter(r =>
    !q || r.name.includes(q) || r.code.toLowerCase().includes(q.toLowerCase())
  );

  return (
    <div className="anim-fade-up" style={{ display:"flex", flexDirection:"column", height:"100%", background:"var(--grouped)" }}>
      {/* Large title header — iOS 26: no divider, icons beside title */}
      <div style={{ padding:"max(12px, var(--safe-top)) 20px 12px", flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"flex-end", justifyContent:"space-between" }}>
          <h1 style={{ margin:0, fontSize:34, fontWeight:700, letterSpacing:"-.03em", color:"var(--text)" }}>
            传话筒
          </h1>
          <div style={{ width:40 }} aria-hidden="true" />
        </div>
      </div>

      <div style={{ padding:"4px 16px 14px" }}>
        <div style={{
          background:"var(--surface)", borderRadius:12, boxShadow:"var(--card-shadow)",
          display:"flex", alignItems:"center", padding:"10px 14px", gap:8,
        }}>
          {IC.search()}
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索公开房间"
            aria-label="搜索公开房间"
            style={{ flex:1, border:"none", outline:"none", background:"transparent", fontSize:15, color:"var(--text)" }}/>
        </div>
      </div>

      <div style={{ flex:1, overflowY:"auto", paddingBottom:84 }}>
        {/* Room list — per spec §03: 16px padding, 44px avatar, 16px card radius */}
        <div style={{ padding:"0 16px", display:"flex", flexDirection:"column", gap:10 }}>
          {list.map(room => (
            <Card key={room.id}>
              <div className="tap" onClick={() => openSheet(room)} style={{
                display:"flex", alignItems:"center", padding:16, gap:12,
              }}>
                <Avi ch={room.initials} color={room.color} size={48}/>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:17, fontWeight:600, color:"var(--text)", marginBottom:3 }}>{room.name}</div>
                  <div style={{ fontSize:14, color:"var(--text-2)", marginBottom:4,
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {room.desc}
                  </div>
                  <div style={{ fontSize:12, color:"var(--text-3)" }}>
                    {room.members.toLocaleString()} 人 · {room.ownerLabel}
                  </div>
                </div>
                {joined.has(room.id) || state.rooms.some(item => item.id === room.id)
                  ? <span style={{ fontSize:13, color:"var(--text-3)", flexShrink:0 }}>已加入</span>
                  : <button onClick={e => { e.stopPropagation(); void onJoined(room); }}
                      style={{
                        background:"var(--brand)", color:"#fff", border:"none",
                        borderRadius:10, fontSize:14, fontWeight:600,
                        padding:"7px 16px", cursor:"pointer", flexShrink:0,
                      }}>加入</button>
                }
              </div>
            </Card>
          ))}
        </div>
      </div>

      {sheet && (
        <WorldSheet room={sheet} joined={joined.has(sheet.id)}
          onJoin={inviteToken => onJoined(sheet, inviteToken)}
          onClose={closeSheet}/>
      )}
    </div>
  );
}

function WorldSheet({ room, joined, onJoin, onClose }: {
  room: Room; joined: boolean; onJoin: (inviteToken?: string | null) => Promise<void>; onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const copy = () => {
    if (!inviteToken) return;
    navigator.clipboard?.writeText(inviteToken).catch(() => {});
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => {
    let active = true;
    setInviteToken(null);
    setInviteError(null);
    void getWorldRoom(room.id).then(detail => {
      if (active) setInviteToken(detail.inviteToken);
    }).catch(err => {
      if (active) setInviteError(err instanceof Error ? err.message : '获取邀请码失败');
    });
    return () => { active = false; };
  }, [room.id]);

  return (
    <div data-testid="world-room-sheet" onClick={onClose} style={{
      position:"fixed", inset:0, zIndex:200,
      background:"rgba(0,0,0,.28)", display:"flex", alignItems:"flex-end", justifyContent:"center",
    }}>
      <div onClick={e => e.stopPropagation()} className="anim-slide-up" style={{
        width:"100%", maxWidth:480, background:"var(--grouped)",
        borderRadius:"20px 20px 0 0",
        paddingBottom:"max(32px, var(--safe-bottom))",
      }}>
        <div style={{ width:36, height:4, borderRadius:2, background:"var(--text-3)",
          margin:"12px auto 20px", opacity:.3 }}/>
        <div style={{ padding:"0 20px" }}>
          <div style={{ display:"flex", gap:14, alignItems:"center", marginBottom:16 }}>
            <Avi ch={room.initials} color={room.color} size={54}/>
            <div>
              <div style={{ fontSize:20, fontWeight:700, color:"var(--text)" }}>{room.name}</div>
              <div style={{ fontSize:14, color:"var(--text-3)", marginTop:3 }}>
                {room.members.toLocaleString()} 名成员 · {room.ownerLabel}
              </div>
            </div>
          </div>
          <p style={{ fontSize:15, color:"var(--text-2)", lineHeight:1.65, margin:"0 0 18px" }}>{room.desc}</p>
          <Card style={{ marginBottom:16 }}>
            <div style={{ padding:"12px 16px" }}>
              <div style={{ fontSize:12, color:"var(--text-3)", marginBottom:6 }}>邀请码</div>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <span style={{ fontSize:14, color:"var(--text-2)" }}>
                  {inviteError ? inviteError : inviteToken || "正在加载邀请码..."}
                </span>
                <button onClick={copy} style={{
                  background:"none", border:"none", cursor:"pointer",
                  display:"flex", alignItems:"center", gap:5,
                  color:"var(--brand)", fontSize:14, fontWeight:500,
                }} disabled={!inviteToken}>
                  <IC.copy/>
                  {copied ? "已复制" : inviteToken ? "复制" : ""}
                </button>
              </div>
            </div>
          </Card>
          {error && <div role="alert" style={{ color:"var(--danger)", fontSize:13, marginBottom:10 }}>{error}</div>}
          <button onClick={() => {
            if (joined || joining) return;
            setJoining(true);
            setError(null);
            void onJoin(inviteToken).catch(error => setError(error instanceof Error ? error.message : "加入失败"))
              .finally(() => setJoining(false));
          }} style={{
            width:"100%", border:"none", borderRadius:14, fontSize:17, fontWeight:600, padding:"15px",
            background: joined ? "var(--surface)" : "var(--brand)",
            color: joined ? "var(--text-3)" : "#fff", cursor:"pointer",
            boxShadow: joined ? "none" : "0 2px 8px rgba(138,107,79,.35)",
          }}>{joined ? "已加入此房间" : joining ? "加入中..." : "加入房间"}</button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   ROOMS
══════════════════════════════════════════════════════════ */

export function Rooms({ rooms, currentUserId, pinnedRoomIds, onRoom, onShareSheet, onTogglePin, onExit }: {
  rooms: Room[];
  currentUserId: string;
  pinnedRoomIds: Set<string>;
  onRoom: (r: Room) => void;
  onShareSheet: () => void;
  onTogglePin: (roomId: string) => void;
  onExit: (room: Room) => Promise<void>;
}) {
  const [actionRoom, setActionRoom] = useState<Room | null>(null);
  const [exitRoom, setExitRoom] = useState<Room | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const suppressClickRef = useRef(false);
  const orderedRooms = [...rooms].sort((left, right) =>
    Number(pinnedRoomIds.has(right.id)) - Number(pinnedRoomIds.has(left.id)));

  const cancelLongPress = () => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
    longPressOriginRef.current = null;
  };

  useEffect(() => cancelLongPress, []);
  useEffect(() => { if (actionRoom) actionButtonRef.current?.focus(); }, [actionRoom]);

  const beginLongPress = (room: Room, clientX: number, clientY: number) => {
    cancelLongPress();
    suppressClickRef.current = false;
    longPressOriginRef.current = { x: clientX, y: clientY };
    longPressTimerRef.current = window.setTimeout(() => {
      suppressClickRef.current = true;
      setActionRoom(room);
      longPressTimerRef.current = null;
    }, 500);
  };

  const moveLongPress = (clientX: number, clientY: number) => {
    const origin = longPressOriginRef.current;
    if (origin && Math.hypot(clientX - origin.x, clientY - origin.y) > 10) {
      suppressClickRef.current = true;
      cancelLongPress();
    }
  };

  return (
    <PageShell title="房间" right={
      <button className="tap" onClick={onShareSheet} aria-label="分享到世界" title="分享到世界"
        style={{ background:"none", border:"none", cursor:"pointer", padding:6, display:"flex" }}>
        {IC.plus()}
      </button>
    }>
      {/* Each room is an independent card capsule — mirrors World list style */}
      <div style={{ padding:"4px 16px 0", display:"flex", flexDirection:"column", gap:10 }}>
        {orderedRooms.map(room => (
          <Card key={room.id}>
            <div className="tap" role="button" tabIndex={0}
              aria-label={`${room.name}${room.unread > 0 ? `，${room.unread} 条未读` : ""}${room.lastMsg ? `，最后消息：${room.lastMsg}` : ""}`}
              onPointerDown={event => beginLongPress(room, event.clientX, event.clientY)}
              onPointerMove={event => moveLongPress(event.clientX, event.clientY)}
              onPointerLeave={cancelLongPress}
              onPointerUp={cancelLongPress}
              onPointerCancel={cancelLongPress}
              onContextMenu={event => { event.preventDefault(); cancelLongPress(); setActionRoom(room); }}
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                onRoom(room);
              }}
              onKeyDown={event => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onRoom(room);
                }
              }} style={{
              display:"flex", alignItems:"center", padding:"13px 16px", gap:13,
            }}>
              <div style={{ position:"relative" }}>
                <Avi ch={room.initials} color={room.color} size={50}/>
                {room.unread > 0 && (
                  <div style={{
                    position:"absolute", top:-3, right:-3,
                    background:"var(--danger)", color:"#fff",
                    borderRadius:9, minWidth:17, height:17,
                    fontSize:10, fontWeight:700, padding:"0 4px",
                    display:"flex", alignItems:"center", justifyContent:"center",
                    border:"2px solid var(--grouped)",
                  }}>{room.unread > 9 ? "9+" : room.unread}</div>
                )}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:4 }}>
                  <span style={{ fontSize:17, fontWeight: room.unread > 0 ? 600 : 400, color:"var(--text)" }}>
                    {room.name}
                  </span>
                  {pinnedRoomIds.has(room.id) && <span style={{ marginLeft:7, fontSize:11, color:"var(--brand)" }}>已置顶</span>}
                  <span style={{ fontSize:12, color:"var(--text-3)", flexShrink:0, marginLeft:8 }}>
                    {room.lastTime}
                  </span>
                </div>
                <div style={{ fontSize:14, color:"var(--text-3)",
                  overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {room.lastMsg}
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>
      {actionRoom && (
        <div onClick={() => setActionRoom(null)} style={{
          position:"fixed", inset:0, zIndex:220, background:"rgba(0,0,0,.28)",
          display:"flex", alignItems:"flex-end", justifyContent:"center",
        }}>
          <div role="dialog" aria-modal="true" aria-label={`${actionRoom.name} 房间操作`}
            onKeyDown={event => { if (event.key === "Escape") setActionRoom(null); }}
            onClick={event => event.stopPropagation()} className="anim-slide-up" style={{
            width:"100%", maxWidth:480, padding:"12px 16px max(24px, var(--safe-bottom))",
            background:"var(--grouped)", borderRadius:"20px 20px 0 0",
          }}>
            <div style={{ width:36, height:4, borderRadius:2, background:"var(--text-3)", margin:"0 auto 14px", opacity:.3 }}/>
            <Card>
              <button ref={actionButtonRef} type="button" onClick={() => {
                onTogglePin(actionRoom.id);
                setActionRoom(null);
              }} style={{ width:"100%", minHeight:52, border:0, background:"transparent", color:"var(--text)", fontSize:16, cursor:"pointer" }}>
                {pinnedRoomIds.has(actionRoom.id) ? "取消置顶" : "置顶"}
              </button>
              <SepL/>
              <button type="button" onClick={() => {
                setExitRoom(actionRoom);
                setActionRoom(null);
              }} style={{ width:"100%", minHeight:52, border:0, background:"transparent", color:"var(--danger)", fontSize:16, cursor:"pointer" }}>
                {actionRoom.ownerUserId === currentUserId ? "解散房间" : "退出"}
              </button>
            </Card>
            <button type="button" onClick={() => setActionRoom(null)} style={{
              width:"100%", minHeight:50, marginTop:10, border:0, borderRadius:14,
              background:"var(--surface)", color:"var(--text-2)", fontSize:16, cursor:"pointer",
            }}>取消</button>
          </div>
        </div>
      )}
      {exitRoom && (
        <ConfirmDialog
          title={exitRoom.ownerUserId === currentUserId ? "解散房间？" : "退出房间？"}
          message={exitRoom.ownerUserId === currentUserId
            ? "你是房主，退出将解散房间并永久删除全部消息，此操作无法撤销。"
            : "退出后，此房间会从房间列表中删除，并且你将退出房间。"}
          confirmLabel={exitRoom.ownerUserId === currentUserId ? "确认解散" : "退出房间"}
          onCancel={() => setExitRoom(null)}
          onConfirm={async () => {
            await onExit(exitRoom);
            setExitRoom(null);
          }}
        />
      )}
    </PageShell>
  );
}

function ShareSheet({ rooms, onClose, onToggle }: {
  rooms: BackendRoom[];
  onClose: () => void;
  onToggle: (room: BackendRoom) => Promise<void>;
}) {
  const [selected, setSelected] = useState(() => new Set(rooms.filter(room => room.worldPublished).map(room => room.id)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (room: BackendRoom) => setSelected(current => {
    const next = new Set(current);
    if (next.has(room.id)) next.delete(room.id); else next.add(room.id);
    return next;
  });
  const save = async () => {
    setSaving(true); setError(null);
    try {
      for (const room of rooms) {
        if (selected.has(room.id) !== room.worldPublished) await onToggle(room);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "分享设置保存失败");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, zIndex:200, background:"rgba(0,0,0,.28)", display:"flex", alignItems:"flex-end", justifyContent:"center" }}>
      <div onClick={event => event.stopPropagation()} className="anim-slide-up" style={{ width:"100%", maxWidth:480, background:"var(--grouped)", borderRadius:"20px 20px 0 0", padding:"12px 20px max(40px, var(--safe-bottom))" }}>
        <div style={{ width:36, height:4, borderRadius:2, background:"var(--text-3)", margin:"0 auto 20px", opacity:.3 }}/>
        <div style={{ fontSize:20, fontWeight:700, color:"var(--text)", marginBottom:6 }}>分享到世界</div>
        <div style={{ fontSize:14, color:"var(--text-2)", marginBottom:16 }}>勾选要公开展示的房间</div>
        <Card style={{ marginBottom:14 }}>
          {rooms.length === 0 ? <div style={{ padding:16, color:"var(--text-3)", fontSize:14 }}>暂无自己创建的房间</div> : rooms.map((room, index) => (
            <div key={room.id}>
              <label style={{ display:"flex", alignItems:"center", gap:12, padding:"14px 16px", cursor:"pointer" }}>
                <input type="checkbox" checked={selected.has(room.id)} onChange={() => toggle(room)} style={{ width:18, height:18, accentColor:"var(--brand)" }}/>
                <span style={{ flex:1, color:"var(--text)", fontSize:15 }}>{room.title}</span>
                <span style={{ color:"var(--text-3)", fontSize:12 }}>{selected.has(room.id) ? "已分享" : "仅成员可见"}</span>
              </label>
              {index < rooms.length - 1 && <SepL/>}
            </div>
          ))}
        </Card>
        {error && <div role="alert" style={{ color:"var(--danger)", fontSize:13, marginBottom:10 }}>{error}</div>}
        <button type="button" onClick={() => void save()} disabled={saving} style={{ width:"100%", border:0, borderRadius:14, padding:15, background:"var(--brand)", color:"#fff", fontSize:16, fontWeight:600 }}>{saving ? "保存中..." : "保存分享设置"}</button>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   CHAT
══════════════════════════════════════════════════════════ */

export function Chat({ room, onBack, bubColor, bubOpacity, chatBg, msgs, onSend, onRecall,
  hasMoreBefore, onLoadOlder, onReachedLatest, wsStatus, currentUserId,
  canDelete, canManageMembers, membersRefreshVersion = 0, onDelete, onRemoveMember }: {
  room: Room; onBack: () => void;
  bubColor: string; bubOpacity: number; chatBg: string | null;
  msgs: Msg[];
  onSend: (text: string) => Promise<void>;
  onRecall: (messageId: string) => Promise<void>;
  hasMoreBefore: boolean;
  onLoadOlder: () => Promise<void>;
  onReachedLatest: (seq: number) => void;
  wsStatus: string;
  currentUserId: string;
  canDelete: boolean;
  canManageMembers: boolean;
  membersRefreshVersion?: number;
  onDelete: () => Promise<void>;
  onRemoveMember: (userId: string) => Promise<void>;
}) {
  const [input, setInput] = useState("");
  const [showMembers, setShowMembers] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [recalling, setRecalling] = useState<string | null>(null);
  const [recallError, setRecallError] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [memberToRemove, setMemberToRemove] = useState<Member | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const previousLastIdRef = useRef<string | null>(null);
  const previousMembersRefreshVersionRef = useRef(membersRefreshVersion);
  const onReachedLatestRef = useRef(onReachedLatest);
  onReachedLatestRef.current = onReachedLatest;

  useEffect(() => {
    const list = listRef.current;
    if (!list || msgs.length === 0) return;
    const latestId = msgs.at(-1)?.id ?? null;
    const firstLoad = previousLastIdRef.current === null;
    const addedAtEnd = latestId !== previousLastIdRef.current;
    previousLastIdRef.current = latestId;
    if (firstLoad || (addedAtEnd && atBottomRef.current)) {
      requestAnimationFrame(() => {
        list.scrollTo({ top:list.scrollHeight, behavior:firstLoad ? "auto" : "smooth" });
        atBottomRef.current = true;
        setPendingCount(0);
        const latest = msgs.at(-1)?.seq;
        if (latest !== undefined) onReachedLatestRef.current(latest);
      });
    } else if (addedAtEnd && !firstLoad) {
      setPendingCount(count => count + 1);
    }
  }, [msgs]);

  const loadOlder = async () => {
    if (!hasMoreBefore || loadingOlder) return;
    setLoadingOlder(true);
    try { await onLoadOlder(); } finally { setLoadingOlder(false); }
  };

  const openMembers = useCallback(async () => {
    setShowMembers(true);
    setMembersLoading(true);
    setMemberError(null);
    try {
      const [humanResult, bindings] = await Promise.all([
        listMembers(room.id),
        listAgentBindings(room.id),
      ]);
      const humanMembers = humanResult.items.map((member: BackendMember) => ({
        id: member.userId,
        name: member.displayName,
        handle: `@${member.userId.slice(-8)}`,
        isAI: false,
        initials: initialsFor(member.displayName),
        color: colorFor(member.userId),
        role: member.role === "owner" ? "owner" as const : "member" as const,
      }));
      const aiMembers = bindings.map((binding: AgentBinding) => ({
        id: binding.bindingId,
        name: binding.displayName,
        handle: "AI Agent",
        isAI: true,
        initials: initialsFor(binding.displayName),
        color: colorFor(binding.agentProfileId),
        role: "member" as const,
        ownerUserId: binding.ownerUserId,
        participationMode: binding.participationMode,
      }));
      setMembers([...humanMembers, ...aiMembers]);
    } catch (error) {
      setMemberError(error instanceof Error ? error.message : "成员加载失败");
    } finally {
      setMembersLoading(false);
    }
  }, [room.id]);

  useEffect(() => {
    if (previousMembersRefreshVersionRef.current === membersRefreshVersion) return;
    previousMembersRefreshVersionRef.current = membersRefreshVersion;
    if (showMembers) void openMembers();
  }, [membersRefreshVersion, openMembers, showMembers]);

  const humanMembers = members.filter(member => !member.isAI);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true); setSendError(null);
    void onSend(text).then(() => setInput("")).catch(error => setSendError(error instanceof Error ? error.message : "发送失败")).finally(() => setSending(false));
  }, [input, onSend, sending]);

  const canSend = input.trim().length > 0;

  return (
    <div className="anim-fade-up" style={{
      position:"absolute", inset:0,
      background: chatBg ? "transparent" : "var(--bg)",
      display:"flex", flexDirection:"column", zIndex:20,
    }}>
      {/* Chat background image */}
      {chatBg && (
        <div style={{
          position:"absolute", inset:0, zIndex:0,
          backgroundImage:`url(${chatBg})`,
          backgroundSize:"cover", backgroundPosition:"center",
        }}/>
      )}

      {/* Floating capsule nav */}
      <div style={{
        padding:"max(8px, var(--safe-top)) 16px 8px",
        flexShrink:0, position:"relative", zIndex:1,
      }}>
        <div style={{
          display:"flex", alignItems:"center", gap:8,
          background:"var(--blur-surface)",
          backdropFilter:"blur(24px) saturate(1.8)",
          WebkitBackdropFilter:"blur(24px) saturate(1.8)",
          borderRadius:28, padding:"7px 12px",
          boxShadow:"0 2px 14px rgba(0,0,0,.10), 0 0 0 .5px rgba(138,107,79,.12)",
        }}>
          <button onClick={onBack} className="tap" aria-label="返回房间列表" style={{
            background:"none", border:"none", cursor:"pointer",
            padding:"4px 8px 4px 2px", display:"flex", alignItems:"center",
          }}>
            <IC.back/>
          </button>
          <div style={{ flex:1, textAlign:"center" }}>
            <div style={{ fontSize:16, fontWeight:600, color:"var(--text)", lineHeight:1.2 }}>{room.name}</div>
            <div style={{ fontSize:11, color:"var(--text-3)" }}>{room.members} 人 · {wsStatus === "open" ? "已连接" : wsStatus === "reconnecting" ? "重连中" : "连接中"}</div>
          </div>
          <button onClick={() => void openMembers()} className="tap" aria-label="查看成员" style={{
            background:"none", border:"none", cursor:"pointer",
            padding:"4px 2px 4px 8px", display:"flex",
          }}>
            <IC.dots/>
          </button>
          {canDelete && <button onClick={() => {
            if (window.confirm("确定删除这个房间吗？房间及全部消息将永久删除。")) void onDelete();
          }} className="tap" aria-label="删除房间" style={{ background:"none", border:0, color:"var(--danger)", fontSize:12, cursor:"pointer", padding:"4px 0 4px 6px" }}>删除</button>}
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex:1, minHeight:0, overflow:"hidden", display:"flex", flexDirection:"column", position:"relative", zIndex:1 }}>
            <div ref={listRef} onScroll={event => {
              const list = event.currentTarget;
              const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
              atBottomRef.current = atBottom;
              if (atBottom) {
                setPendingCount(0);
                const latest = msgs.at(-1)?.seq;
                if (latest !== undefined) onReachedLatestRef.current(latest);
              }
              if (list.scrollTop < 64 && hasMoreBefore) void loadOlder();
            }} style={{ flex:1, overflowY:"auto", padding:"12px 14px 0", display:"flex", flexDirection:"column", gap:2, position:"relative", zIndex:1 }}>
            {hasMoreBefore && <button type="button" onClick={() => void loadOlder()} disabled={loadingOlder} style={{ alignSelf:"center", border:0, borderRadius:12, background:"var(--surface)", color:"var(--brand)", padding:"7px 12px", cursor:"pointer", fontSize:12 }}>{loadingOlder ? "正在加载..." : "加载更早消息"}</button>}
            {msgs.map((msg, idx) => {
          const showTime = idx === 0 || msgs[idx - 1].time !== msg.time;
          return (
            <div key={msg.id}>
              {showTime && (
                <div style={{ textAlign:"center", fontSize:12, color:"var(--text-3)", padding:"10px 0 8px" }}>
                  {msg.time}
                </div>
              )}
              <div style={{
                display:"flex",
                flexDirection: msg.isMe ? "row-reverse" : "row",
                alignItems:"flex-start", gap:8, marginBottom:8,
              }}>
                <PhotoAvi src={msg.avatar} ch={msg.initials} color={msg.color} size={34}/>
                <div style={{
                  display:"flex", flexDirection:"column",
                  alignItems: msg.isMe ? "flex-end" : "flex-start",
                  maxWidth:"72%", gap:4,
                }}>
                  <div style={{ display:"flex", alignItems:"center", gap:5,
                    marginLeft: msg.isMe ? 0 : 2, marginRight: msg.isMe ? 2 : 0 }}>
                    <span style={{ fontSize:12, color:"var(--text-3)", fontWeight:500 }}>
                      {msg.isMe ? "你" : msg.sender}
                    </span>
                    {msg.isAI && <AITag/>}
                  </div>
                  <div style={{
                    padding:"10px 14px",
                    background: msg.isMe
                      ? `color-mix(in srgb, ${bubColor} ${bubOpacity}%, transparent)`
                      : (chatBg
                          ? `rgba(255,255,255,${(bubOpacity / 100) * 0.82 + 0.10})`
                          : `color-mix(in srgb, var(--bub-other-bg) ${bubOpacity}%, transparent)`),
                    backdropFilter: (chatBg && !msg.isMe) ? "blur(12px)" : undefined,
                    WebkitBackdropFilter: (chatBg && !msg.isMe) ? "blur(12px)" : undefined,
                    color: msg.isMe
                      ? (bubOpacity < 50 ? "var(--text)" : "#fff")
                      : "var(--bub-other-fg)",
                    borderRadius: msg.isMe ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
                    fontSize:15, lineHeight:1.5, wordBreak:"break-word",
                    boxShadow:"0 1px 3px rgba(0,0,0,.08)",
                  }}>{msg.replyTo && <div style={{ borderLeft:"2px solid var(--brand)", paddingLeft:8, marginBottom:6, color:"var(--text-3)", fontSize:12 }}><div>{msg.replyTo.sender}</div><div style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{msg.replyTo.text}</div></div>}{highlightedText(msg.text)}</div>
                  {msg.isMe && (
                    <div style={{ display:"flex", alignItems:"center", gap:8, marginRight:2 }}>
                      <IC.check2/>
                      {msg.text !== "这条消息已撤回" && (
                        <button type="button" onClick={() => {
                          if (recalling) return;
                          setRecalling(msg.id); setRecallError(null);
                          void onRecall(msg.id).catch(error => setRecallError(error instanceof Error ? error.message : "撤回失败")).finally(() => setRecalling(null));
                        }} style={{ border:0, background:"transparent", color:"var(--text-3)", fontSize:11, cursor:"pointer" }}>
                          {recalling === msg.id ? "撤回中" : "撤回"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
            <div style={{ height:8 }}/>
            </div>
            {pendingCount > 0 && <button type="button" onClick={() => { const list = listRef.current; list?.scrollTo({ top:list.scrollHeight, behavior:"smooth" }); setPendingCount(0); }} style={{ position:"absolute", right:20, bottom:92, zIndex:2, border:0, borderRadius:16, background:"var(--surface)", color:"var(--brand)", boxShadow:"var(--card-shadow)", padding:"7px 12px", cursor:"pointer", fontSize:12 }}>{pendingCount} 条新消息</button>}
            {sendError && <div role="alert" style={{ position:"absolute", left:16, right:16, bottom:88, zIndex:2, color:"var(--danger)", background:"var(--surface)", borderRadius:10, padding:"8px 12px", fontSize:12 }}>{sendError}</div>}
            {recallError && <div role="alert" style={{ position:"absolute", left:16, right:16, bottom:88, zIndex:2, color:"var(--danger)", background:"var(--surface)", borderRadius:10, padding:"8px 12px", fontSize:12 }}>{recallError}</div>}

      {/* Input bar — floating capsule wrapper */}
      <div style={{
        padding:"10px 16px max(8px, var(--safe-bottom))",
        background:"transparent",
        flexShrink:0, position:"relative", zIndex:1,
      }}>
        <div style={{
          display:"flex", alignItems:"center", gap:10,
          background:"var(--blur-surface)",
          backdropFilter:"blur(24px) saturate(1.8)",
          WebkitBackdropFilter:"blur(24px) saturate(1.8)",
          borderRadius:28, padding:"8px 8px 8px 14px",
          boxShadow:"0 2px 14px rgba(0,0,0,.10), 0 0 0 .5px rgba(138,107,79,.12)",
        }}>
          <div style={{
            flex:1, background:"var(--surface)", borderRadius:22,
            padding:"10px 16px", display:"flex", alignItems:"center",
            boxShadow:"0 1px 4px rgba(0,0,0,.06)",
          }}>
              <input aria-label="消息" maxLength={32768} value={input} onChange={e => { setInput(e.target.value); setSendError(null); }}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="输入消息..."
              style={{ flex:1, border:"none", outline:"none", background:"transparent",
                fontSize:15, color:"var(--text)" }}/>
          </div>
          <button onClick={send} disabled={!canSend || sending} aria-label={sending ? "发送中" : "发送"} style={{
            height:40, borderRadius:20, border:"none", flexShrink:0,
            background: canSend ? "var(--brand)" : "rgba(142,142,147,.2)",
            padding: canSend ? "0 18px" : "0",
            width: canSend ? "auto" : 40,
            display:"flex", alignItems:"center", justifyContent:"center",
            cursor: canSend && !sending ? "pointer" : "default", transition:"all .15s",
            boxShadow: canSend ? "0 2px 8px rgba(138,107,79,.4)" : "none",
          }}>
            {canSend
              ? <span style={{ fontSize:15, fontWeight:600, color:"#fff" }}>{sending ? "发送中" : "发送"}</span>
              : (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M2 8L14 2l-6 12V8H2z" fill="var(--text-3)"/>
                </svg>
              )
            }
          </button>
        </div>
      </div>

      {/* Members panel */}
      {showMembers && (
        <div onClick={() => setShowMembers(false)} style={{
          position:"absolute", inset:0, background:"rgba(0,0,0,.18)", zIndex:10,
          display:"flex", justifyContent:"flex-end",
        }}>
          <div onClick={e => e.stopPropagation()} className="anim-slide-r" style={{
            width:"min(84vw, 320px)", height:"100%",
            background:"var(--surface)", display:"flex", flexDirection:"column", overflow:"hidden",
            boxShadow:"-10px 0 30px rgba(29,24,20,.10)",
          }}>
            <div style={{ padding:"max(8px, var(--safe-top)) 12px 8px 16px", display:"flex", alignItems:"center", justifyContent:"space-between", color:"var(--text)", flexShrink:0, borderBottom:".5px solid var(--sep)" }}>
              <span style={{ fontSize:17, fontWeight:600 }}>成员 ({members.length})</span>
              <button type="button" onClick={() => setShowMembers(false)} aria-label="关闭成员" style={{ minWidth:44, minHeight:44, border:0, background:"transparent", color:"var(--text-3)", cursor:"pointer", fontSize:13 }}>关闭</button>
            </div>
            {memberError && <div role="alert" style={{ color:"var(--danger)", fontSize:13, padding:"0 16px 12px" }}>{memberError}</div>}
            <div role="list" aria-label="房间成员" style={{ flex:1, overflowY:"auto", paddingBottom:"max(12px, var(--safe-bottom))" }}>
              {membersLoading ? (
                <div style={{ color:"var(--text-3)", fontSize:13, padding:"20px 16px" }}>正在加载成员...</div>
              ) : humanMembers.length === 0 && !memberError ? (
                <div style={{ color:"var(--text-3)", fontSize:13, padding:"20px 16px" }}>暂无成员</div>
              ) : humanMembers.map((member, index) => {
                const agents = members.filter(item => item.isAI && item.ownerUserId === member.id);
                return (
                  <div key={member.id} role="listitem" aria-label={member.name}>
                    <div style={{ display:"flex", alignItems:"center", padding:"12px 16px 9px", gap:12 }}>
                      <div style={{ position:"relative", flexShrink:0 }}>
                        <Avi ch={member.initials} color={member.color} size={38}/>
                      </div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:5, minWidth:0 }}>
                          <span style={{ minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", fontSize:14, fontWeight:500, color:"var(--text)" }}>{member.name}</span>
                          {member.role === "owner" && (
                            <span style={{ flexShrink:0, fontSize:10, color:C.orange, background:"rgba(224,162,74,.12)",
                              borderRadius:4, padding:"1px 5px", fontWeight:600 }}>房主</span>
                          )}
                        </div>
                        <div style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", fontSize:12, color:"var(--text-3)" }}>{member.handle}</div>
                      </div>
                      {canManageMembers && member.id !== currentUserId && (
                        <button type="button" aria-label={`将 ${member.name} 移出房间`}
                          onClick={() => setMemberToRemove(member)} style={{
                            flexShrink:0, border:"1px solid color-mix(in srgb, var(--danger) 35%, transparent)",
                            borderRadius:8, background:"transparent", color:"var(--danger)",
                            padding:"5px 9px", fontSize:12, cursor:"pointer",
                          }}>移出</button>
                      )}
                    </div>
                    {agents.length > 0 && (
                      <div role="list" aria-label={`${member.name} 的 AI`} style={{ margin:"0 16px 10px 35px", paddingLeft:14, borderLeft:"1px solid var(--sep)" }}>
                        {agents.map(agent => (
                          <div key={agent.id} role="listitem" style={{ display:"flex", alignItems:"center", gap:10, minHeight:42, padding:"5px 0" }}>
                            <Avi ch={agent.initials} color={agent.color} size={30}/>
                            <div style={{ flex:1, minWidth:0, display:"flex", alignItems:"center", gap:5 }}>
                              <span style={{ minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", fontSize:13.5, fontWeight:500, color:"var(--text)" }}>{agent.name}</span>
                              <AITag/>
                            </div>
                            <span style={{ flexShrink:0, fontSize:11, color:agent.participationMode === "off" ? "var(--text-3)" : "var(--text-2)" }}>
                              {agent.participationMode === "automatic" ? "自动" : agent.participationMode === "manual" ? "手动" : "停用"}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {index < humanMembers.length - 1 && <SepL/>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      {memberToRemove && (
        <ConfirmDialog
          title={`将“${memberToRemove.name}”移出房间？`}
          message="该成员会立即退出房间，之后无法继续查看或发送房间消息。"
          confirmLabel="确认移出"
          onCancel={() => setMemberToRemove(null)}
          onConfirm={async () => {
            await onRemoveMember(memberToRemove.id);
            setMembers(current => current.filter(member =>
              member.id !== memberToRemove.id && member.ownerUserId !== memberToRemove.id));
            setMemberToRemove(null);
          }}
        />
      )}
    </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   ME
══════════════════════════════════════════════════════════ */

function Me({ user, deviceCount, activeAgentCount, onView, onLogout }: {
  user: User; deviceCount: number; activeAgentCount: number;
  onView: (v: View) => void; onLogout: () => void;
}) {
  return (
    <PageShell title="我">
      <div style={{ padding:"4px 16px 20px" }}>
        <Card>
          <div style={{ padding:16, display:"flex", alignItems:"center", gap:14 }}>
            <div data-testid="me-avatar">
              <PhotoAvi
                src={user.avatarResourceId
                  ? `/v1/profile-resources/${encodeURIComponent(user.avatarResourceId)}`
                  : undefined}
                ch={initialsFor(user.displayName)}
                color={C.brand}
                size={62}
              />
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:19, fontWeight:700, color:"var(--text)" }}>{user.displayName}</div>
              <div style={{ fontSize:14, color:"var(--text-3)", marginTop:2 }}>@{user.handle}</div>
              <div style={{ fontSize:13, color:"var(--text-2)", marginTop:5 }}>传话筒用户</div>
            </div>
            <button onClick={() => onView({v:"profile"})} style={{
              background:"var(--grouped)", border:"none", borderRadius:8,
              padding:"6px 14px", fontSize:14, fontWeight:500,
              color:"var(--brand)", cursor:"pointer", flexShrink:0,
            }}>编辑</button>
          </div>
        </Card>
      </div>

      <SecLabel label="账号"/>
      <div style={{ margin:"0 16px" }}>
        <Card>
          <Row label="个人资料" onClick={() => onView({v:"profile"})}/>
          <SepL/>
          <Row label="修改密码" onClick={() => onView({v:"password"})}/>
        </Card>
      </div>

      <SecLabel label="功能"/>
      <div style={{ margin:"0 16px" }}>
        <Card>
          <Row label="我的 AI" value={`${activeAgentCount} 个`} onClick={() => onView({v:"myai"})}/>
          <SepL/>
          <Row label="MCP 设备" value={`${deviceCount} 个`} onClick={() => onView({v:"mcp"})}/>
          <SepL/>
          <Row label="聊天外观" onClick={() => onView({v:"appearance"})}/>
        </Card>
      </div>

      <SecLabel label="其他"/>
      <div style={{ margin:"0 16px" }}>
        <Card>
          <Row label="关于传话筒" onClick={() => {}}/>
          <SepL/>
          <Row label="退出登录" danger noArrow onClick={onLogout}/>
        </Card>
      </div>

      <div style={{ textAlign:"center", fontSize:12, color:"var(--text-3)", padding:"24px 0 8px" }}>
        传话筒 v1.0.0
      </div>
    </PageShell>
  );
}

/* ══════════════════════════════════════════════════════════
   SETTINGS SUB-PAGES
══════════════════════════════════════════════════════════ */

function ProfilePage({ user, onBack, onSaved }: {
  user: User;
  onBack: () => void;
  onSaved: (name: string, avatarFile: File | null) => Promise<void>;
}) {
  const [name, setName] = useState(user.displayName);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | undefined>(
    user.avatarResourceId
      ? `/v1/profile-resources/${encodeURIComponent(user.avatarResourceId)}`
      : undefined,
  );
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <SubShell title="个人资料" onBack={onBack}>
      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", padding:"28px 0 20px" }}>
        <label htmlFor="profile-avatar-upload" style={{ position:"relative", cursor:"pointer" }}>
          <PhotoAvi src={avatarPreview} ch={initialsFor(name)} color={C.brand} size={80}/>
          <div style={{
            position:"absolute", bottom:0, right:0,
            width:26, height:26, borderRadius:13,
            background:"var(--brand)", border:"2.5px solid var(--grouped)",
            display:"flex", alignItems:"center", justifyContent:"center",
          }}>
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M7.5 1.5L9.5 3.5L3.5 9.5H1.5V7.5L7.5 1.5Z" stroke="#fff" strokeWidth="1.3" strokeLinejoin="round"/>
            </svg>
          </div>
        </label>
        <input id="profile-avatar-upload" type="file" accept="image/jpeg,image/png,image/webp"
          style={{ display:"none" }} onChange={event => {
            const file = event.target.files?.[0] ?? null;
            setAvatarFile(file);
            if (file) setAvatarPreview(URL.createObjectURL(file));
            event.target.value = "";
          }}/>
        <div style={{ fontSize:14, color:"var(--brand)", marginTop:10, fontWeight:500 }}>更换头像</div>
      </div>
      <SecLabel label="基本信息"/>
      <div style={{ margin:"0 16px" }}>
        <Card>
          <FieldRow label="昵称" value={name} onChange={setName} placeholder="输入昵称"/>
          <SepL/>
          <Row label="用户名" value={`@${user.handle}`} noArrow/>
        </Card>
      </div>
      <div style={{ padding:"20px 16px 0" }}>
        {error && <div role="alert" style={{ background:"rgba(211,92,77,.12)", color:"var(--danger)",
          borderRadius:10, padding:"10px 14px", fontSize:14, marginBottom:12 }}>{error}</div>}
        {saved && <div style={{ background:"rgba(111,191,108,.12)", color:"var(--success)",
          borderRadius:10, padding:"10px 14px", fontSize:14, marginBottom:12 }}>已保存</div>}
        <button onClick={() => {
          if (saving) return;
          setSaving(true); setError(null); setSaved(false);
          void onSaved(name.trim(), avatarFile).then(() => setSaved(true))
            .catch(error => setError(error instanceof Error ? error.message : "保存失败"))
            .finally(() => setSaving(false));
        }} style={{
          width:"100%", border:"none", borderRadius:14, fontSize:17, fontWeight:600, padding:"15px",
          background:"var(--brand)", color:"#fff", cursor:"pointer",
          boxShadow:"0 2px 8px rgba(138,107,79,.35)",
        }}>{saving ? "保存中..." : "保存"}</button>
      </div>
    </SubShell>
  );
}

function PasswordPage({ onBack, onChanged }: { onBack: () => void; onChanged: (current: string, next: string) => Promise<void> }) {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [conf, setConf] = useState("");
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = next && conf && next !== conf;
  const ok = !!(cur && next && conf && !mismatch);
  return (
    <SubShell title="修改密码" onBack={onBack}>
      <div style={{ height:16 }}/>
      <SecLabel label="密码"/>
      <div style={{ margin:"0 16px" }}>
        <Card>
          <FieldRow label="当前密码" type="password" value={cur} onChange={setCur} placeholder="输入当前密码"/>
          <SepL/>
          <FieldRow label="新密码" type="password" value={next} onChange={setNext} placeholder="至少 8 位"/>
          <SepL/>
          <FieldRow label="确认密码" type="password" value={conf} onChange={setConf} placeholder="再次输入新密码"/>
        </Card>
      </div>
      {mismatch && <div style={{ padding:"8px 20px 0", fontSize:13, color:"var(--danger)" }}>两次输入的密码不一致</div>}
      <div style={{ padding:"20px 16px 0" }}>
        {error && <div role="alert" style={{ background:"rgba(211,92,77,.12)", color:"var(--danger)",
          borderRadius:10, padding:"10px 14px", fontSize:14, marginBottom:12 }}>{error}</div>}
        {done && <div style={{ background:"rgba(111,191,108,.12)", color:"var(--success)",
          borderRadius:10, padding:"10px 14px", fontSize:14, marginBottom:12 }}>密码已修改</div>}
        <button onClick={() => {
          if (!ok || saving) return;
          setSaving(true); setError(null); setDone(false);
          void onChanged(cur, next).then(() => {
            setDone(true); setCur(""); setNext(""); setConf("");
          }).catch(error => setError(error instanceof Error ? error.message : "修改失败"))
            .finally(() => setSaving(false));
        }} style={{
          width:"100%", border:"none", borderRadius:14, fontSize:17, fontWeight:600, padding:"15px",
          background: ok && !saving ? "var(--brand)" : "rgba(142,142,147,.2)",
          color: ok && !saving ? "#fff" : "var(--text-3)", cursor: ok && !saving ? "pointer" : "default",
          boxShadow: ok && !saving ? "0 2px 8px rgba(138,107,79,.35)" : "none",
        }}>{saving ? "修改中..." : "更改密码"}</button>
      </div>
    </SubShell>
  );
}

function MCPPage({ onBack, devices, onCreate, onRevoke }: {
  onBack: () => void; devices: Array<{ deviceId: string; label: string; active: boolean; kind: string }>;
  onCreate: (label: string) => Promise<McpDeviceCreation>; onRevoke: (deviceId: string) => Promise<void>;
}) {
  const mcpDevices = devices.filter(device => device.kind !== "web");
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<McpDeviceCreation | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (key: string, value: string) => {
    await navigator.clipboard?.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied(current => current === key ? null : current), 1600);
  };
  return (
    <SubShell title="MCP 设备" onBack={onBack}>
      <SecLabel label={`已连接 (${mcpDevices.filter(d => d.active).length})`}/>
      <div style={{ margin:"0 16px" }}>
        <Card>
          {mcpDevices.map((d, i) => (
            <div key={d.deviceId}>
              <div style={{ display:"flex", alignItems:"center", padding:"14px 16px", gap:12 }}>
                <Dot on={d.active}/>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:15, fontWeight:500, color:"var(--text)" }}>{d.label}</div>
                  <div style={{ fontSize:12, color:"var(--text-3)", marginTop:2 }}>
                    {d.active ? "可用" : "已停用"}
                  </div>
                </div>
                <button onClick={() => {
                  if (d.active) {
                    void onRevoke(d.deviceId);
                  }
                }} style={{
                  background: d.active ? "rgba(211,92,77,.1)" : "rgba(138,107,79,.1)",
                  color: d.active ? "var(--danger)" : "var(--brand)",
                  border:"none", borderRadius:8, fontSize:13, fontWeight:500,
                  padding:"5px 12px", cursor:"pointer", flexShrink:0,
                }}>{d.active ? "停用" : "已停用"}</button>
              </div>
              {i < mcpDevices.length - 1 && <SepL/>}
            </div>
          ))}
        </Card>
      </div>
      <div style={{ padding:"20px 16px 0" }}>
        {!creating ? (
          <button type="button" onClick={() => { setCreating(true); setCreateError(null); }} style={{
            width:"100%", border:"none", borderRadius:14, fontSize:17, fontWeight:600, padding:"15px",
            background:"var(--brand)", color:"#fff", cursor:"pointer",
            boxShadow:"0 2px 8px rgba(138,107,79,.35)",
          }}>创建新设备令牌</button>
        ) : (
          <div>
            <label htmlFor="mcp-device-label" style={{ display:"block", fontSize:13, fontWeight:600, color:"var(--text-2)", marginBottom:8 }}>设备名称</label>
            <input id="mcp-device-label" autoFocus value={label} maxLength={80}
              onChange={event => setLabel(event.target.value)} placeholder="例如：办公室电脑"
              style={{ width:"100%", minHeight:48, boxSizing:"border-box", border:"1px solid var(--separator)", borderRadius:12, padding:"12px 14px", background:"var(--surface)", color:"var(--text)", fontSize:16 }}/>
            {createError && <div role="alert" style={{ color:"var(--danger)", fontSize:13, marginTop:8 }}>{createError}</div>}
            <div style={{ display:"flex", gap:8, marginTop:12 }}>
              <button type="button" disabled={busy} onClick={() => { setCreating(false); setLabel(""); setCreateError(null); }} style={{
                flex:1, border:"none", borderRadius:12, padding:12, background:"var(--surface)", color:"var(--text-2)", cursor:busy ? "default" : "pointer", fontSize:15,
              }}>取消</button>
              <button type="button" disabled={!label.trim() || busy} onClick={() => {
                if (!label.trim() || busy) return;
                setBusy(true); setCreateError(null);
                void onCreate(label.trim()).then(result => {
                  setCreated(result);
                  setLabel("");
                  setCreating(false);
                }).catch(error => setCreateError(error instanceof Error ? error.message : "设备令牌创建失败"))
                  .finally(() => setBusy(false));
              }} style={{
                flex:1, border:"none", borderRadius:12, padding:12, fontSize:15, fontWeight:600,
                background:label.trim() && !busy ? "var(--brand)" : "var(--separator)",
                color:label.trim() && !busy ? "#fff" : "var(--text-3)", cursor:label.trim() && !busy ? "pointer" : "default",
              }}>{busy ? "创建中..." : "确认创建"}</button>
            </div>
          </div>
        )}
      </div>
      {created && (
        <div style={{ padding:"20px 16px 0" }}>
          <Card style={{ padding:16 }}>
            <div style={{ fontSize:16, fontWeight:600, color:"var(--text)", marginBottom:4 }}>设备已创建</div>
            <div style={{ fontSize:13, color:"var(--text-2)", marginBottom:14 }}>Token 只显示这一次，请立即保存。</div>
            {[
              ["服务器地址", created.mcpUrl.replace(/\?.*$/, ""), "url"],
              ["请求头名称", "Authorization", "name"],
              ["请求头值", created.authorizationHeader, "value"],
            ].map(([labelText, value, key]) => (
              <div key={key} style={{ marginTop:10 }}>
                <div style={{ fontSize:12, color:"var(--text-3)", marginBottom:4 }}>{labelText}</div>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <code style={{ flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", fontSize:12, color:"var(--text-2)" }}>{value}</code>
                  <button type="button" onClick={() => void copy(key, value)} style={{ border:0, background:"var(--grouped)", color:"var(--brand)", borderRadius:8, padding:"6px 10px", cursor:"pointer" }}>
                    {copied === key ? "已复制" : "复制"}
                  </button>
                </div>
              </div>
            ))}
            <button type="button" onClick={() => setCreated(null)} style={{ marginTop:14, border:0, background:"transparent", color:"var(--text-3)", cursor:"pointer", fontSize:13 }}>我已保存</button>
          </Card>
        </div>
      )}
    </SubShell>
  );
}

function MyAIPage({ onBack, profiles, onSaved, onDeleted }: {
  onBack: () => void;
  profiles: AgentProfile[];
  onSaved: (profile: AgentProfile) => void;
  onDeleted: (profileId: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState<AgentProfile | null>(null);
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [avatar, setAvatar] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const beginEdit = (profile: AgentProfile) => {
    setEditing(profile); setName(profile.displayName); setBio(profile.shortBio); setAvatar(null); setError(null);
  };
  const save = async () => {
    if (!editing || !name.trim()) return;
    setSaving(true); setError(null);
    try {
      const uploaded = avatar ? await uploadAvatar(avatar) : null;
      const updated = await updateAgentProfile(editing.id, {
        expectedProfileRevision: editing.profileRevision,
        displayName: name.trim(),
        shortBio: bio.trim(),
        ...(uploaded ? { avatarResourceId: uploaded.id } : {}),
      });
      onSaved(updated); setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };
  return (
    <SubShell title="我的 AI" onBack={onBack}>
      <SecLabel label="AI 助理"/>
      <div style={{ margin:"0 16px" }}>
        <Card>
          {profiles.map((ag, i) => (
            <div key={ag.id}>
              <button type="button" onClick={() => beginEdit(ag)} style={{ width:"100%", display:"flex", alignItems:"center", padding:"12px 16px", gap:12, border:0, background:"transparent", textAlign:"left", cursor:"pointer" }}>
                <Avi ch={initialsFor(ag.displayName)} color={colorFor(ag.id)} size={44}/>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ fontSize:15, fontWeight:500, color:"var(--text)" }}>{ag.displayName}</span>
                    <AITag/>
                  </div>
                  <div style={{ fontSize:13, color:"var(--text-2)", marginTop:2 }}>{ag.shortBio || "未填写简介"}</div>
                </div>
                <span style={{ fontSize:12, color:"var(--text-3)" }}>由房间管理</span>
              </button>
              {i < profiles.length - 1 && <SepL/>}
            </div>
          ))}
        </Card>
      </div>
      {editing && (
        <div style={{ padding:"20px 16px 0" }}>
          <Card style={{ padding:16 }}>
            <div style={{ fontSize:16, fontWeight:600, color:"var(--text)", marginBottom:12 }}>编辑 AI 资料</div>
            <FieldRow label="名称" value={name} onChange={setName} placeholder="AI 名称"/>
            <SepL/>
            <FieldRow label="简介" value={bio} onChange={setBio} placeholder="一句话介绍"/>
            <div style={{ marginTop:12 }}>
              <label style={{ fontSize:13, color:"var(--text-2)" }}>头像</label>
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={event => setAvatar(event.target.files?.[0] ?? null)} style={{ display:"block", width:"100%", marginTop:8, color:"var(--text-2)" }}/>
            </div>
            {error && <div role="alert" style={{ color:"var(--danger)", fontSize:13, marginTop:10 }}>{error}</div>}
            <div style={{ display:"flex", gap:8, marginTop:16 }}>
              <button type="button" onClick={() => setEditing(null)} style={{ flex:1, border:0, borderRadius:12, padding:12, background:"var(--grouped)", color:"var(--text-2)", cursor:"pointer" }}>取消</button>
              <button type="button" disabled={saving || !name.trim()} onClick={() => void save()} style={{ flex:1, border:0, borderRadius:12, padding:12, background:"var(--brand)", color:"#fff", cursor:"pointer" }}>{saving ? "保存中..." : "保存"}</button>
            </div>
            <button type="button" onClick={() => {
              if (!editing || !window.confirm("删除这个 AI 资料？它会同时从已绑定的房间中移除。")) return;
              void onDeleted(editing.id).then(() => setEditing(null)).catch(err => setError(err instanceof Error ? err.message : "删除失败"));
            }} style={{ width:"100%", marginTop:10, border:0, background:"transparent", color:"var(--danger)", cursor:"pointer", fontSize:13 }}>删除这个 AI 资料</button>
          </Card>
        </div>
      )}
    </SubShell>
  );
}

/* Predefined background options for chat */
const BG_OPTIONS: { label: string; value: string | null; preview: string }[] = [
  { label:"默认", value:null, preview:"var(--bg)" },
  { label:"暖沙", value:"https://images.unsplash.com/photo-1501854140801-50d01698950b?w=800&q=80", preview:"#c8b89a" },
  { label:"茶园", value:"https://images.unsplash.com/photo-1556679343-c7306c1976bc?w=800&q=80", preview:"#7a9e7e" },
  { label:"云雾", value:"https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=800&q=80", preview:"#b8c8d8" },
  { label:"樱花", value:"https://images.unsplash.com/photo-1522383225653-ed111181a951?w=800&q=80", preview:"#f4c5c5" },
];

export function AppearancePage({ onBack, color, setColor, opacity, setOpacity, chatBg, setChatBg, dark, setDark }: {
  onBack: () => void;
  color: string; setColor: (v: string) => void;
  opacity: number; setOpacity: (v: number) => void;
  chatBg: string | null; setChatBg: (v: string | null) => void;
  dark: boolean; setDark: (v: boolean) => void;
}) {
  const palette = [C.brand, C.green, C.orange, C.blue, C.red, C.purple];
  const fileRef = useRef<HTMLInputElement>(null);
  const [customBg, setCustomBg] = useState<string | null>(() => chatBg?.startsWith("blob:") ? chatBg : null);
  const [backgroundError, setBackgroundError] = useState<string | null>(null);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBackgroundError(null);
    try {
      await saveChatBackground(file);
      const url = await readChatBackgroundUrl();
      setCustomBg(url);
      setChatBg(url);
    } catch (error) {
      setBackgroundError(error instanceof Error ? error.message : "聊天背景更新失败");
    } finally {
      // reset so same file can be re-selected
      e.target.value = "";
    }
  };

  const handlePreset = async (value: string | null) => {
    setBackgroundError(null);
    try {
      const selected = await selectChatBackgroundPreset(value);
      setCustomBg(null);
      setChatBg(selected);
    } catch {
      setBackgroundError("聊天背景更新失败");
    }
  };

  return (
    <SubShell title="聊天外观" onBack={onBack}>
      {/* Dark mode */}
      <SecLabel label="主题"/>
      <div style={{ margin:"0 16px" }}>
        <Card>
          <Row label="深色模式" right={<Toggle on={dark} onChange={setDark}/>} noArrow/>
        </Card>
      </div>

      {/* Preview */}
      <SecLabel label="预览"/>
      <div style={{ margin:"0 16px" }}>
        <div style={{
          borderRadius:"var(--card-r)", overflow:"hidden",
          boxShadow:"var(--card-shadow)",
          background: chatBg ? "transparent" : "var(--bg)",
          backgroundImage: chatBg ? `url(${chatBg})` : "none",
          backgroundSize:"cover", backgroundPosition:"center",
          padding:16, display:"flex", flexDirection:"column", gap:10,
        }}>
          <div style={{ display:"flex", gap:8, alignItems:"flex-end" }}>
            <div style={{ width:34, height:34, borderRadius:17, background:C.orange, flexShrink:0 }}/>
            <div style={{
              background: chatBg
                ? `rgba(255,255,255,${(opacity / 100) * 0.82 + 0.10})`
                : `color-mix(in srgb, var(--bub-other-bg) ${opacity}%, transparent)`,
              backdropFilter: chatBg ? "blur(12px)" : undefined,
              borderRadius:"16px 16px 16px 4px",
              padding:"9px 13px", fontSize:14, color:"var(--bub-other-fg)",
              boxShadow:"0 1px 3px rgba(0,0,0,.08)",
            }}>你好，这是对方的消息</div>
          </div>
          <div style={{ display:"flex", justifyContent:"flex-end", gap:8, alignItems:"flex-end" }}>
            <div style={{
              background:`color-mix(in srgb, ${color} ${opacity}%, transparent)`,
              borderRadius:"16px 16px 4px 16px",
              padding:"9px 13px", fontSize:14, color:"#fff",
              boxShadow:"0 1px 3px rgba(0,0,0,.1)",
            }}>这是我发送的消息</div>
            <div style={{ width:34, height:34, borderRadius:17, background:C.brand, flexShrink:0 }}/>
          </div>
        </div>
      </div>

      {/* Bubble color */}
      <SecLabel label="气泡颜色"/>
      <div style={{ margin:"0 16px" }}>
        <Card>
          <div style={{ padding:16, display:"flex", gap:14, flexWrap:"wrap" }}>
            {palette.map(c => (
              <div key={c} className="tap" onClick={() => setColor(c)} style={{
                width:36, height:36, borderRadius:18, background:c, cursor:"pointer",
                outline: color === c ? `3px solid ${c}` : "none", outlineOffset:2,
                transition:"outline .15s",
              }}/>
            ))}
          </div>
        </Card>
      </div>

      {/* Bubble opacity */}
      <SecLabel label="气泡透明度"/>
      <div style={{ margin:"0 16px" }}>
        <Card>
          <div style={{ padding:"14px 16px" }}>
            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:10 }}>
              <span style={{ fontSize:14, color:"var(--text-2)" }}>透明度</span>
              <span style={{ fontSize:14, fontWeight:600, color:"var(--text)" }}>{opacity}%</span>
            </div>
            <input type="range" min={30} max={100} value={opacity}
              onChange={e => setOpacity(+e.target.value)}
              style={{ width:"100%", accentColor:"var(--brand)", cursor:"pointer" }}/>
          </div>
        </Card>
      </div>

      {/* Chat background */}
      <SecLabel label="聊天背景"/>
      <div style={{ margin:"0 16px" }}>
        <Card>
          <div style={{ padding:14, display:"flex", gap:10, overflowX:"auto" }}>
            {/* Preset options */}
            {BG_OPTIONS.map(opt => (
              <div key={opt.label} className="tap" onClick={() => void handlePreset(opt.value)}
                style={{ flexShrink:0, display:"flex", flexDirection:"column", alignItems:"center", gap:6 }}>
                <div style={{
                  width:64, height:96, borderRadius:12,
                  background: opt.value ? "transparent" : opt.preview,
                  backgroundImage: opt.value ? `url(${opt.value})` : "none",
                  backgroundSize:"cover", backgroundPosition:"center",
                  border: chatBg === opt.value ? `2.5px solid var(--brand)` : "2px solid transparent",
                  boxShadow: chatBg === opt.value ? `0 0 0 1px var(--brand)` : "var(--card-shadow)",
                  transition:"border .15s",
                }}/>
                <span style={{ fontSize:11, color: chatBg === opt.value ? "var(--brand)" : "var(--text-3)", fontWeight: chatBg === opt.value ? 600 : 400 }}>
                  {opt.label}
                </span>
              </div>
            ))}
            {/* Custom upload tile */}
            <div className="tap" onClick={() => fileRef.current?.click()}
              style={{ flexShrink:0, display:"flex", flexDirection:"column", alignItems:"center", gap:6 }}>
              <div style={{
                width:64, height:96, borderRadius:12,
                background: customBg ? "transparent" : "var(--grouped)",
                backgroundImage: customBg ? `url(${customBg})` : "none",
                backgroundSize:"cover", backgroundPosition:"center",
                border: chatBg === customBg && customBg ? `2.5px solid var(--brand)` : "2px dashed var(--text-3)",
                boxShadow: chatBg === customBg && customBg ? `0 0 0 1px var(--brand)` : "none",
                display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:4,
                transition:"border .15s",
              }}>
                {!customBg && <>
                  <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                    <path d="M11 3v16M3 11h16" stroke="var(--text-3)" strokeWidth="1.8" strokeLinecap="round"/>
                  </svg>
                </>}
              </div>
              <span style={{ fontSize:11, color: chatBg === customBg && customBg ? "var(--brand)" : "var(--text-3)", fontWeight: chatBg === customBg && customBg ? 600 : 400 }}>
                {customBg ? "自定义" : "上传"}
              </span>
            </div>
            {/* Hidden file input */}
            <input ref={fileRef} type="file" accept="image/*" onChange={e => void handleUpload(e)}
              style={{ display:"none" }}/>
          </div>
        </Card>
        {backgroundError && <div role="alert" style={{ color:"var(--danger)", fontSize:12, padding:"8px 4px 0" }}>{backgroundError}</div>}
      </div>
    </SubShell>
  );
}

/* ══════════════════════════════════════════════════════════
   APP ROOT
══════════════════════════════════════════════════════════ */

function LoginGate() {
  const { login, register } = useApp();
  const [mode, setMode] = useState<"login" | "register" | "reset">("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [bindingCode, setBindingCode] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      if (mode === "login") {
        await login(username.trim(), password);
      } else if (mode === "register") {
        if (password !== confirmation) throw new Error("两次输入的密码不一致");
        await register({ username: username.trim(), displayName: displayName.trim(), password, passwordConfirmation: confirmation, bindingCode: bindingCode.trim() });
      } else {
        if (password !== confirmation) throw new Error("两次输入的密码不一致");
        await resetPassword({ username: username.trim(), newPassword: password, passwordConfirmation: confirmation, resetCode: resetCode.trim() });
        setMode("login"); setPassword(""); setConfirmation(""); setResetCode("");
        setNotice("密码已重置，请使用新密码登录");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ minHeight:"100%", display:"grid", placeItems:"center", padding:24, background:"var(--grouped)" }}>
      <Card style={{ width:"100%", maxWidth:420, padding:24 }}>
        <div style={{ fontSize:34, fontWeight:700, color:"var(--text)", marginBottom:6 }}>传话筒</div>
        <div style={{ color:"var(--text-2)", marginBottom:16 }}>使用传话筒 Web 账号</div>
        <div style={{ display:"flex", gap:6, padding:4, borderRadius:12, background:"var(--grouped)", marginBottom:14 }}>
          {([["login", "登录"], ["register", "绑定账号"], ["reset", "重置密码"]] as const).map(([value, label]) => (
            <button type="button" role="tab" aria-selected={mode === value} key={value} onClick={() => { setMode(value); setError(null); setNotice(null); }} style={{ flex:1, border:0, borderRadius:9, padding:"8px 4px", background:mode === value ? "var(--surface)" : "transparent", color:mode === value ? "var(--brand)" : "var(--text-3)", fontSize:13, fontWeight:mode === value ? 600 : 400, cursor:"pointer" }}>{label}</button>
          ))}
        </div>
        <form onSubmit={event => { event.preventDefault(); void submit(); }}>
          <FieldRow label="用户名" value={username} onChange={setUsername} placeholder="输入用户名"/>
          {mode === "register" && <>
            <SepL/>
            <FieldRow label="显示名" value={displayName} onChange={setDisplayName} placeholder="输入显示名"/>
            <SepL/>
            <FieldRow label="绑定码" value={bindingCode} onChange={value => setBindingCode(value.toUpperCase())} placeholder="XXXX-XXXX"/>
          </>}
          {mode === "reset" && <>
            <SepL/>
            <FieldRow label="重置码" value={resetCode} onChange={value => setResetCode(value.toUpperCase())} placeholder="XXXX-XXXX"/>
          </>}
          <SepL/>
          <FieldRow label={mode === "reset" ? "新密码" : "密码"} type="password" value={password} onChange={setPassword} placeholder="输入密码"/>
          {mode !== "login" && <><SepL/><FieldRow label="确认密码" type="password" value={confirmation} onChange={setConfirmation} placeholder="再次输入密码"/></>}
          {error && <div role="alert" style={{ color:"var(--danger)", fontSize:13, paddingTop:12 }}>{error}</div>}
          {notice && <div role="status" style={{ color:"var(--success)", fontSize:13, paddingTop:12 }}>{notice}</div>}
          {mode === "register" && <div style={{ color:"var(--text-3)", fontSize:12, paddingTop:10 }}>绑定码由已连接传话筒的 AI 生成。</div>}
          <button type="submit" disabled={busy || !username || !password} style={{
            width:"100%", marginTop:18, border:0, borderRadius:14, padding:15,
            background: busy || !username || !password ? "rgba(142,142,147,.2)" : "var(--brand)",
            color: busy || !username || !password ? "var(--text-3)" : "#fff", fontSize:17, fontWeight:600,
          }}>{busy ? "处理中..." : mode === "login" ? "登录" : mode === "register" ? "绑定并登录" : "重置密码"}</button>
        </form>
      </Card>
    </div>
  );
}

export default function App() {
  const { state, dispatch, refreshRooms, loadLatestMessages, loadMessagesAfter, logout } = useApp();
  const [tab, setTab] = useState<Tab>("world");
  const [view, setView] = useState<View | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [worldSheetOpen, setWorldSheetOpen] = useState(false);
  const [dark, setDarkState] = useState(() => localStorage.getItem("chuanhuatong_dark_mode") === "1");
  const [bubColor, setBubColorState] = useState(readBubbleColor);
  const [bubOpacity, setBubOpacityState] = useState(readBubbleOpacity);
  const [chatBg, setChatBg] = useState<string | null>(null);
  const [worldRooms, setWorldRooms] = useState<Room[]>([]);
  const [joinedWorld, setJoinedWorld] = useState<Set<string>>(new Set());
  const [devices, setDevices] = useState<Array<{ deviceId: string; label: string; active: boolean; kind: string }>>([]);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [historyMeta, setHistoryMeta] = useState<Record<string, boolean>>({});
  const [membersRefreshVersions, setMembersRefreshVersions] = useState<Record<string, number>>({});
  const [pinnedRoomIds, setPinnedRoomIds] = useState<Set<string>>(new Set());
  const [pinnedStorageUserId, setPinnedStorageUserId] = useState<string | null>(null);

  useEffect(() => { document.documentElement.classList.toggle("dark", dark); localStorage.setItem("chuanhuatong_dark_mode", dark ? "1" : "0"); }, [dark]);
  useEffect(() => { void readChatBackgroundUrl().then(setChatBg); }, []);
  useEffect(() => {
    if (!state.me) {
      setPinnedRoomIds(new Set());
      setPinnedStorageUserId(null);
      return;
    }
    try {
      const stored = JSON.parse(localStorage.getItem(`chuanhuatong_pinned_rooms:${state.me.userId}`) ?? "[]");
      setPinnedRoomIds(new Set(Array.isArray(stored) ? stored.filter(value => typeof value === "string") : []));
    } catch {
      setPinnedRoomIds(new Set());
    }
    setPinnedStorageUserId(state.me.userId);
  }, [state.me]);
  useEffect(() => {
    if (!state.me || pinnedStorageUserId !== state.me.userId) return;
    localStorage.setItem(
      `chuanhuatong_pinned_rooms:${state.me.userId}`,
      JSON.stringify([...pinnedRoomIds]),
    );
  }, [pinnedRoomIds, pinnedStorageUserId, state.me]);
  const setDark = useCallback((value: boolean) => setDarkState(value), []);
  const setBubColor = useCallback((value: string) => { applyBubbleColor(value); setBubColorState(value); }, []);
  const setBubOpacity = useCallback((value: number) => { applyBubbleOpacity(value); setBubOpacityState(value); }, []);

  useEffect(() => {
    if (state.authStatus !== "authenticated") return;
    void Promise.all([listWorldRooms(), listDevices(), listAgentProfiles()])
      .then(([world, deviceItems, agentItems]) => {
        setWorldRooms(world.map(toWorldRoom));
        setDevices(deviceItems);
        setProfiles(agentItems);
      });
  }, [state.authStatus, state.profileVersion]);

  const removePinnedRoom = useCallback((roomId: string) => {
    setPinnedRoomIds(current => {
      if (!current.has(roomId)) return current;
      const next = new Set(current);
      next.delete(roomId);
      return next;
    });
  }, []);

  const handleWsEvent = useCallback((event: WsEvent) => {
    if (event.type === "connection.ready") {
      void refreshRooms();
      void Promise.all(state.rooms.map(room => loadMessagesAfter(room.id, state.lastSeqs[room.id] ?? 0)));
    } else if (event.type === "message.created" && event.roomId && event.payload) {
      dispatch({ type: "APPEND_MESSAGE", roomId: event.roomId, message: event.payload });
    } else if (event.type === "message.recalled" && event.roomId && event.payload) {
      dispatch({ type: "REPLACE_MESSAGE", roomId: event.roomId, message: event.payload });
    } else if (event.type === "room.deleted" && event.roomId) {
      dispatch({ type: "REMOVE_ROOM", roomId: event.roomId });
      removePinnedRoom(event.roomId);
      if (view?.v === "chat" && view.room.id === event.roomId) setView(null);
    } else if (event.type === "room.membership_removed" && event.roomId) {
      const membershipEvent = event as RoomMembershipRemovedEvent;
      if (membershipEvent.payload.userId === state.me?.userId) {
        dispatch({ type: "REMOVE_ROOM", roomId: membershipEvent.roomId });
        removePinnedRoom(membershipEvent.roomId);
        if (view?.v === "chat" && view.room.id === membershipEvent.roomId) setView(null);
      } else {
        void refreshRooms();
        setMembersRefreshVersions(current => ({
          ...current,
          [membershipEvent.roomId]: (current[membershipEvent.roomId] ?? 0) + 1,
        }));
      }
    } else if (event.type === "profile.updated") {
      const profileEvent = event as ProfileUpdatedEvent;
      if (profileEvent.payload.profileType === "human" && profileEvent.payload.ownerUserId === state.me?.userId) {
        dispatch({ type: "SET_ME", me: profileEvent.payload.profile as User });
      }
      dispatch({ type: "PROFILE_UPDATED" });
    }
  }, [dispatch, loadMessagesAfter, refreshRooms, removePinnedRoom, state.lastSeqs, state.me?.userId, state.rooms, view]);

  useRealtimeWS(handleWsEvent, status => dispatch({ type: "SET_WS_STATUS", status }), state.authStatus === "authenticated");

  useEffect(() => {
    if (view?.v !== "chat") return;
    void loadLatestMessages(view.room.id).then(page => {
      setHistoryMeta(current => ({ ...current, [view.room.id]: page.hasMore }));
      const latest = page.items.at(-1)?.seq ?? 0;
      if (latest > 0) {
        void markRoomRead(view.room.id, latest).then(result => {
          dispatch({ type: "MARK_ROOM_READ", roomId: view.room.id, readSeq: result.webReadSeq });
        });
      }
    }).catch(() => undefined);
  }, [dispatch, loadLatestMessages, view]);

  const uiRooms = state.rooms.map(toUiRoom);
  const ownedRooms = state.rooms.filter(room => room.ownerUserId === state.me?.userId);
  const unread = uiRooms.reduce((sum, room) => sum + room.unread, 0);
  const push = (next: View) => setView(next);
  const pop = () => setView(null);

  const togglePinnedRoom = useCallback((roomId: string) => {
    if (!state.me) return;
    setPinnedRoomIds(current => {
      const next = new Set(current);
      if (next.has(roomId)) next.delete(roomId); else next.add(roomId);
      return next;
    });
  }, [state.me]);

  const exitRoomFromList = useCallback(async (room: Room) => {
    if (!state.me) return;
    if (room.ownerUserId === state.me.userId) await deleteRoom(room.id);
    else await leaveRoom(room.id);
    dispatch({ type: "REMOVE_ROOM", roomId: room.id });
    removePinnedRoom(room.id);
  }, [dispatch, removePinnedRoom, state.me]);

  const joinWorldRoom = useCallback(async (room: Room, inviteToken?: string | null) => {
    const token = inviteToken ?? (await getWorldRoom(room.id)).inviteToken;
    await acceptInvite(token);
    await refreshRooms();
    setJoinedWorld(previous => new Set(previous).add(room.id));
    setTab("rooms");
  }, [refreshRooms]);

  const toggleWorldPublished = useCallback(async (room: BackendRoom) => {
    await updateWorldRoom(room.id, !room.worldPublished, room.worldSummary ?? "");
    await Promise.all([refreshRooms(), listWorldRooms().then(world => setWorldRooms(world.map(toWorldRoom)))]);
  }, [refreshRooms]);

  const renderView = () => {
    if (!view || !state.me) return null;
    if (view.v === "chat") {
      const backendMessages = state.messages[view.room.id] ?? [];
      const byId = new Map(backendMessages.map(message => [message.id, message]));
      const messages = backendMessages.map(message => toUiMessage(message, state.me!.userId, message.replyToMessageId ? byId.get(message.replyToMessageId) : undefined));
      return <Chat key={view.room.id} room={view.room} onBack={pop} bubColor={bubColor} bubOpacity={bubOpacity} chatBg={chatBg}
        currentUserId={state.me!.userId}
        canDelete={view.room.ownerUserId === state.me!.userId}
        canManageMembers={view.room.ownerUserId === state.me!.userId}
        membersRefreshVersion={membersRefreshVersions[view.room.id] ?? 0}
        onDelete={async () => { await deleteRoom(view.room.id); dispatch({ type: "REMOVE_ROOM", roomId: view.room.id }); pop(); }}
        onRemoveMember={async userId => {
          await removeRoomMember(view.room.id, userId);
          await refreshRooms();
          setView(current => current?.v === "chat" && current.room.id === view.room.id
            ? { ...current, room: { ...current.room, members: Math.max(0, current.room.members - 1) } }
            : current);
        }}
        hasMoreBefore={historyMeta[view.room.id] ?? false}
        onLoadOlder={async () => {
          const oldest = state.messages[view.room.id]?.[0]?.seq;
          if (oldest === undefined) return;
          const page = await loadLatestMessages(view.room.id, oldest);
          setHistoryMeta(current => ({ ...current, [view.room.id]: page.hasMore }));
        }}
        onReachedLatest={seq => {
          if (seq > 0) void markRoomRead(view.room.id, seq).then(result => dispatch({ type: "MARK_ROOM_READ", roomId: view.room.id, readSeq: result.webReadSeq }));
        }}
        wsStatus={state.wsStatus}
        msgs={messages}
        onSend={async text => {
          const message = await sendMessage(view.room.id, text);
          dispatch({ type: "APPEND_MESSAGE", roomId: view.room.id, message });
        }}
        onRecall={async messageId => {
          const message = await recallMessage(view.room.id, messageId);
          dispatch({ type: "REPLACE_MESSAGE", roomId: view.room.id, message });
        }}/>
    }
    if (view.v === "profile") return <ProfilePage user={state.me} onBack={pop} onSaved={async (name, avatarFile) => {
      const uploaded = avatarFile ? await uploadAvatar(avatarFile) : null;
      const updated = await updateMe({
        expectedProfileRevision: state.me!.profileRevision,
        displayName: name,
        ...(uploaded ? { avatarResourceId: uploaded.id } : {}),
      });
      dispatch({ type: "SET_ME", me: updated });
    }}/>
    if (view.v === "password") return <PasswordPage onBack={pop} onChanged={(current, next) => changePassword({ currentPassword: current, newPassword: next, passwordConfirmation: next })}/>;
    if (view.v === "mcp") return <MCPPage onBack={pop} devices={devices} onCreate={async label => {
      const created = await createMcpDevice(label); setDevices(await listDevices()); return created;
    }} onRevoke={async deviceId => {
      await revokeDevice(deviceId); setDevices(await listDevices());
    }}/>;
    if (view.v === "myai") return <MyAIPage onBack={pop} profiles={profiles} onSaved={updated => {
      setProfiles(items => items.map(item => item.id === updated.id ? updated : item));
    }} onDeleted={async profileId => {
      await deleteAgentProfile(profileId);
      setProfiles(items => items.filter(item => item.id !== profileId));
    }}/>;
    return <AppearancePage onBack={pop} color={bubColor} setColor={setBubColor} opacity={bubOpacity} setOpacity={setBubOpacity} chatBg={chatBg} setChatBg={setChatBg} dark={dark} setDark={setDark}/>;
  };

  if (state.authStatus === "loading") return <div className="app-loading" aria-label="正在检查登录状态"/>;
  if (state.authStatus === "anonymous") return <LoginGate/>;

  return (
    <div style={{ width:"100%", height:"100%", display:"flex", alignItems:"stretch", justifyContent:"center", background:"var(--grouped)" }}>
      <div style={{ width:"100%", maxWidth:480, display:"flex", flexDirection:"column", position:"relative", overflow:"hidden", background:"var(--grouped)" }}>
        <div style={{ flex:1, position:"relative", overflow:"hidden" }}>
          {tab === "world" && <World rooms={worldRooms} onJoined={joinWorldRoom} joined={joinedWorld} onSheetOpenChange={setWorldSheetOpen}/>}
          {tab === "rooms" && <Rooms rooms={uiRooms} currentUserId={state.me!.userId}
            pinnedRoomIds={pinnedRoomIds} onRoom={room => push({v:"chat", room})}
            onShareSheet={() => setShareOpen(true)} onTogglePin={togglePinnedRoom}
            onExit={exitRoomFromList}/>}
          {tab === "me" && <Me user={state.me!} deviceCount={devices.filter(device => device.kind !== "web").length} activeAgentCount={profiles.length} onView={push} onLogout={() => void logout()}/>}
          {renderView()}
          {shareOpen && <ShareSheet rooms={ownedRooms} onClose={() => setShareOpen(false)} onToggle={toggleWorldPublished}/>}
        </div>
        {!view && !worldSheetOpen && <BottomNav tab={tab} setTab={setTab} unread={unread}/>}
      </div>
    </div>
  );
}
