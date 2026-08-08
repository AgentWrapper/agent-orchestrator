import { Feather } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Image, Keyboard, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { haptics } from "../haptics";
import type { Theme } from "../theme";
import { useTheme, useThemedStyles } from "../ThemeProvider";
import { MicKey } from "../voice/MicKey";
import { useVoiceInput } from "../voice/useVoiceInput";
import type { ChatConfigOption, ChatImage, ChatResource, ChatSkill, ConversationSnapshot } from "./types";
import {
	findComposerSuggestion,
	rankComposerFiles,
	rankComposerSkills,
	replaceComposerSuggestion,
	type ComposerSuggestion,
} from "./composerSuggestions";

type Attachment =
	| { id: string; kind: "image"; name: string; bytes: number; image: ChatImage }
	| { id: string; kind: "resource"; name: string; bytes: number; resource: ChatResource };

const MAX_EMBEDDED_FILE_BYTES = 500_000;
const MAX_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES_TOTAL = 25 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/bmp"]);

export function ChatComposer({
	sessionId,
	snapshot,
	skills,
	filePaths,
	filePathsTruncated,
	configOptions,
	steerUnavailable,
	pending,
	error,
	onSend,
	onSteer,
	onInterrupt,
	onOpenSettings,
}: {
	sessionId: string;
	snapshot: ConversationSnapshot;
	skills: ChatSkill[];
	filePaths: string[];
	filePathsTruncated?: boolean;
	configOptions?: ChatConfigOption[];
	steerUnavailable?: boolean;
	pending?: boolean;
	error?: string;
	onSend(text: string, attachments?: ChatImage[], resources?: ChatResource[]): Promise<void>;
	onSteer(text: string): Promise<void>;
	onInterrupt(): void;
	onOpenSettings(): void;
}) {
	const t = useTheme();
	const styles = useThemedStyles(makeStyles);
	const [text, setText] = useState("");
	const [cursor, setCursor] = useState(0);
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [picker, setPicker] = useState<"skills" | "files" | undefined>();
	const [query, setQuery] = useState("");
	const [trigger, setTrigger] = useState<ComposerSuggestion>();
	const [delivery, setDelivery] = useState<"steer" | "queue">("steer");
	const [localError, setLocalError] = useState<string>();
	const [submitting, setSubmitting] = useState(false);
	const active = snapshot.turns.some((turn) => turn.state === "running");
	const canSteer = snapshot.capabilities?.includes("steer") && !steerUnavailable && active;
	const canEmbedFiles = snapshot.capabilities?.includes("embedded_context");
	const steerEligible = canSteer && delivery === "steer" && attachments.length === 0;
	const stopped = snapshot.controller.state === "stopped";
	const draftKey = `ao.chat.draft.${sessionId}`;

	useEffect(() => { let mounted = true; void AsyncStorage.getItem(draftKey).then((value) => { if (mounted && value) setText((current) => current || value); }); return () => { mounted = false; }; }, [draftKey]);
	useEffect(() => { const timer = setTimeout(() => void (text ? AsyncStorage.setItem(draftKey, text) : AsyncStorage.removeItem(draftKey)), 250); return () => clearTimeout(timer); }, [draftKey, text]);

	const voice = useVoiceInput({ onTranscript: useCallback((spoken: string) => setText((old) => old ? `${old} ${spoken}` : spoken), []) });

	const submit = useCallback(async () => {
		if (submitting) return;
		const trimmed = text.trim();
		if (!trimmed && attachments.length === 0) return;
		setLocalError(undefined);
		setSubmitting(true);
		try {
			const images = attachments.filter((item): item is Extract<Attachment, { kind: "image" }> => item.kind === "image").map((item) => item.image);
			const resources = attachments.filter((item): item is Extract<Attachment, { kind: "resource" }> => item.kind === "resource").map((item) => item.resource);
			if (steerEligible) await onSteer(trimmed);
			else await onSend(trimmed, images.length ? images : undefined, resources.length ? resources : undefined);
			setText("");
			setAttachments([]);
			void AsyncStorage.removeItem(draftKey);
			Keyboard.dismiss();
			haptics.success();
		} catch (cause) {
			setLocalError(cause instanceof Error ? cause.message : String(cause));
			haptics.error();
		} finally { setSubmitting(false); }
	}, [text, attachments, steerEligible, onSteer, onSend, draftKey, submitting]);

	const addImage = async () => {
		setLocalError(undefined);
		try {
			const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], base64: true, quality: 0.82, allowsMultipleSelection: true, selectionLimit: 4 });
			if (result.canceled) return;
			const errors = new Set<string>();
			const next = result.assets.flatMap((asset): Attachment[] => {
				if (!asset.base64) { errors.add("Some images couldn't be read and were skipped."); return []; }
				const mimeType = (asset.mimeType || "image/jpeg").toLowerCase();
				if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) { errors.add("Only PNG, JPEG, GIF, WebP, and BMP images are supported."); return []; }
				const bytes = asset.fileSize ?? Math.floor(asset.base64.length * 0.75);
				if (bytes > MAX_IMAGE_BYTES) { errors.add("Each image must be under 10 MB."); return []; }
				return [{ id: `${asset.assetId ?? asset.uri}-${Date.now()}`, kind: "image", name: asset.fileName || "Image", bytes, image: { mimeType, data: asset.base64 } }];
			});
			const accepted = [...attachments];
			let imageBytes = accepted.filter((item) => item.kind === "image").reduce((sum, item) => sum + item.bytes, 0);
			for (const item of next) {
				if (accepted.length >= MAX_ATTACHMENTS) { errors.add(`You can attach up to ${MAX_ATTACHMENTS} items.`); break; }
				if (imageBytes + item.bytes > MAX_IMAGE_BYTES_TOTAL) { errors.add("Images must total under 25 MB."); break; }
				accepted.push(item);
				imageBytes += item.bytes;
			}
			setAttachments(accepted);
			if (accepted.length) setDelivery("queue");
			setLocalError(errors.size ? [...errors].join(" ") : undefined);
		} catch (cause) {
			setLocalError(cause instanceof Error ? cause.message : "Could not open the photo library.");
		}
	};
	const addFile = async () => {
		setLocalError(undefined);
		const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: ["text/*", "application/json", "application/xml", "application/yaml"] });
		if (result.canceled) return;
		try {
			const added: Attachment[] = [];
			for (const asset of result.assets) {
				if (attachments.length + added.length >= MAX_ATTACHMENTS) throw new Error(`You can attach up to ${MAX_ATTACHMENTS} items.`);
				if ((asset.size ?? 0) > MAX_EMBEDDED_FILE_BYTES) throw new Error(`${asset.name} is larger than 500 KB. Reference a worktree file with @ instead.`);
				const body = await fetch(asset.uri).then((response) => response.text());
				const bytes = new TextEncoder().encode(body).byteLength;
				if (bytes > MAX_EMBEDDED_FILE_BYTES) throw new Error(`${asset.name} is too large to embed. Reference a worktree file with @ instead.`);
				added.push({ id: `${asset.uri}-${Date.now()}`, kind: "resource", name: asset.name, bytes, resource: { uri: `mobile-attachment://${encodeURIComponent(asset.name)}`, name: asset.name, mimeType: asset.mimeType || "text/plain", text: body } });
			}
			setAttachments((old) => [...old, ...added]);
			if (added.length) setDelivery("queue");
		} catch (cause) { setLocalError(cause instanceof Error ? cause.message : String(cause)); }
	};

	const providerModel = configOptions?.find((option) => option.category === "model" || option.id === "model" || option.id === "agent");
	const providerModelLabel = providerModel?.type === "select" ? providerModel.choices.find((choice) => choice.value === providerModel.currentValue)?.name ?? providerModel.currentValue : undefined;
	const selectedModel = snapshot.modelReroute?.toModel || providerModelLabel || snapshot.settings.model;
	useEffect(() => {
		const suggestion = findComposerSuggestion(text, cursor);
		if (suggestion && (suggestion.kind === "skills" ? skills.length > 0 : filePaths.length > 0)) {
			setTrigger(suggestion);
			setPicker(suggestion.kind);
			setQuery(suggestion.query);
			return;
		}
		// Only auto-close a picker that came from a text trigger. A picker opened
		// from the toolbar has no trigger and stays browsable.
		if (trigger) {
			setTrigger(undefined);
			setPicker(undefined);
			setQuery("");
		}
	// `trigger` is the result of this effect, not an input to it. Depending on it
	// makes every detected token allocate a new trigger object, which recursively
	// re-runs the effect until React reports "Maximum update depth exceeded". It
	// also immediately reopens a picker the user just dismissed. Re-evaluate only
	// when the composer text/caret or the available suggestion sources change.
	}, [cursor, filePaths.length, skills.length, text]);
	return (
		<View style={styles.dock}>
			{voice.state === "starting" || voice.state === "recording" ? <View style={styles.voice}><Feather name="mic" size={12} color={t.red} /><Text style={styles.voiceText}>{voice.partial || (voice.state === "starting" ? "Keep holding…" : "Listening…")}</Text></View> : null}
			{attachments.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.attachments}>{attachments.map((item) => <View key={item.id} style={styles.attachment}>{item.kind === "image" ? <Image accessibilityIgnoresInvertColors source={{ uri: `data:${item.image.mimeType};base64,${item.image.data}` }} style={styles.attachmentImage} /> : <Feather name="file-text" size={13} color={t.blue} />}<Text numberOfLines={1} style={styles.attachmentName}>{item.name}</Text><Pressable hitSlop={7} accessibilityLabel={`Remove ${item.name}`} onPress={() => setAttachments((old) => old.filter((candidate) => candidate.id !== item.id))}><Feather name="x" size={13} color={t.textTertiary} /></Pressable></View>)}</ScrollView> : null}
			{error || localError || voice.error ? <Text accessibilityRole="alert" style={styles.error}>{localError || error || voice.error}</Text> : null}
			<View style={[styles.composer, stopped && { opacity: 0.55 }]}>
				<TextInput
					accessibilityLabel="Message the agent"
					editable={!stopped}
					value={text}
					onChangeText={setText}
					onSelectionChange={(event) => setCursor(event.nativeEvent.selection.start)}
					placeholder={stopped ? "Agent is stopped" : active ? (steerEligible ? "Agent is working — this goes into its running turn" : "Agent is working — this sends when it finishes") : skills.length ? "Ask the agent…  / for skills, @ for files" : "Ask the agent…  @ for files"}
					placeholderTextColor={t.textFaint}
					style={styles.input}
					multiline
					maxLength={40_000}
				/>
				{canSteer ? <DeliveryChoice value={attachments.length ? "queue" : delivery} onChange={setDelivery} steerDisabled={attachments.length > 0 || submitting} /> : null}
				<View style={styles.controls}>
					<IconButton icon="paperclip" label="Attach image" onPress={addImage} disabled={stopped} />
					{canEmbedFiles ? <IconButton icon="file-plus" label="Attach text file" onPress={addFile} disabled={stopped} /> : null}
					{skills.length ? <IconButton icon="command" label="Skills" onPress={() => { setQuery(""); setPicker("skills"); }} disabled={stopped} /> : null}
					{filePaths.length ? <IconButton icon="at-sign" label="Worktree files" onPress={() => { setQuery(""); setPicker("files"); }} disabled={stopped} /> : null}
					<Pressable accessibilityRole="button" accessibilityLabel="Turn settings" onPress={onOpenSettings} style={styles.settingLabel}><Feather name="cpu" size={13} color={t.textTertiary} /><Text numberOfLines={1} style={styles.settingText}>{selectedModel || "Default"}</Text></Pressable>
					<View style={{ flex: 1 }} />
					<MicKey state={voice.state} mode={voice.mode} onPressIn={voice.pressIn} onPressOut={voice.pressOut} />
					{active && !text.trim() ? <Pressable accessibilityRole="button" accessibilityLabel="Stop turn" onPress={onInterrupt} style={styles.stop}><Feather name="square" size={14} color={t.textPrimary} /></Pressable> : <Pressable accessibilityRole="button" accessibilityLabel={steerEligible ? "Steer turn" : active ? "Queue message" : "Send message"} accessibilityState={{ disabled: stopped || pending || submitting }} disabled={stopped || pending || submitting || (!text.trim() && attachments.length === 0)} onPress={() => void submit()} style={({ pressed }) => [styles.send, pressed && { opacity: 0.8 }, (stopped || pending || submitting || (!text.trim() && attachments.length === 0)) && { opacity: 0.35 }]}>{pending || submitting ? <ActivityIndicator size="small" color={t.onAccent} /> : <Feather name={steerEligible ? "corner-up-right" : "arrow-up"} size={17} color={t.onAccent} />}</Pressable>}
				</View>
			</View>
			<SuggestionModal kind={picker} query={query} setQuery={setQuery} skills={skills} filePaths={filePaths} filePathsTruncated={filePathsTruncated} onClose={() => { setPicker(undefined); setTrigger(undefined); }} onPick={(value) => {
				setText((old) => {
					const next = trigger && trigger.kind === picker
						? replaceComposerSuggestion(old, trigger, value)
						: `${old}${old && !/\s$/.test(old) ? " " : ""}${picker === "skills" ? `/${value}` : (/\s/.test(value) ? `"${value}"` : value)} `;
					setCursor(next.length);
					return next;
				});
				setPicker(undefined);
				setTrigger(undefined);
			}} />
		</View>
	);
}

function IconButton({ icon, label, onPress, disabled }: { icon: keyof typeof Feather.glyphMap; label: string; onPress(): void; disabled?: boolean }) { const t = useTheme(); const styles = useThemedStyles(makeStyles); return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} hitSlop={7} onPress={() => { haptics.tap(); void onPress(); }} style={styles.iconButton}><Feather name={icon} size={17} color={disabled ? t.textFaint : t.textTertiary} /></Pressable>; }

function DeliveryChoice({ value, onChange, steerDisabled }: { value: "steer" | "queue"; onChange(value: "steer" | "queue"): void; steerDisabled?: boolean }) {
	const t = useTheme();
	const styles = useThemedStyles(makeStyles);
	return <View accessibilityRole="radiogroup" accessibilityLabel="Where this message goes while the agent is working" style={styles.deliveryChoice}>
		{(["steer", "queue"] as const).map((option) => {
			const disabled = option === "steer" && steerDisabled;
			const selected = value === option;
			return <Pressable key={option} accessibilityRole="radio" accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={() => onChange(option)} style={[styles.deliveryOption, selected && styles.deliveryOptionSelected, disabled && { opacity: 0.35 }]}><Text style={[styles.deliveryOptionText, selected && { color: t.textPrimary }]}>{option === "steer" ? "Steer this turn" : "Queue for next"}</Text></Pressable>;
		})}
		{steerDisabled ? <Text style={styles.deliveryHint}>Attachments start a new turn.</Text> : null}
	</View>;
}

function SuggestionModal({ kind, query, setQuery, skills, filePaths, filePathsTruncated, onClose, onPick }: { kind?: "skills" | "files"; query: string; setQuery(value: string): void; skills: ChatSkill[]; filePaths: string[]; filePathsTruncated?: boolean; onClose(): void; onPick(value: string): void }) {
	const t = useTheme();
	const styles = useThemedStyles(makeStyles);
	const choices = useMemo(() => {
		if (kind === "skills") return rankComposerSkills(skills, query);
		return rankComposerFiles(filePaths, query);
	}, [kind, query, skills, filePaths]);
	return <Modal visible={Boolean(kind)} transparent animationType="slide" onRequestClose={onClose}><Pressable style={styles.scrim} onPress={onClose} /><View style={styles.suggestionSheet}><View style={styles.suggestionHeader}><Text style={styles.suggestionTitle}>{kind === "skills" ? "Skills" : "Worktree files"}</Text><Pressable onPress={onClose} hitSlop={10}><Feather name="x" size={19} color={t.textSecondary} /></Pressable></View><TextInput autoFocus value={query} onChangeText={setQuery} placeholder={kind === "skills" ? "Find a skill" : "Find a file"} placeholderTextColor={t.textFaint} style={styles.search} />{kind === "files" && filePathsTruncated ? <Text style={styles.truncated}>Showing the daemon's capped path list. Narrow your search or type a path directly.</Text> : null}<ScrollView keyboardShouldPersistTaps="handled">{choices.map((choice) => <Pressable key={choice.value} onPress={() => onPick(choice.value)} style={styles.suggestionRow}><View style={{ flex: 1 }}><Text style={styles.suggestionLabel}>{choice.label}</Text>{choice.detail ? <Text numberOfLines={2} style={styles.suggestionDetail}>{choice.detail}</Text> : null}</View>{choice.badge ? <Text style={styles.badge}>{choice.badge}</Text> : null}</Pressable>)}{!choices.length ? <Text style={styles.none}>No matches</Text> : null}</ScrollView></View></Modal>;
}

const makeStyles = (t: Theme) => StyleSheet.create({
	dock: { paddingHorizontal: 10, paddingTop: 8, paddingBottom: 8, backgroundColor: t.bgSurface, borderTopWidth: 1, borderTopColor: t.borderSubtle },
	composer: { borderRadius: 16, backgroundColor: t.bgElevated, borderWidth: 1, borderColor: t.borderDefault, paddingHorizontal: 11, paddingTop: 8, paddingBottom: 8 },
	input: { minHeight: 44, maxHeight: 150, color: t.textPrimary, fontSize: 15, lineHeight: 21, padding: 0, textAlignVertical: "top" },
	controls: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: 2, marginTop: 5 },
	iconButton: { width: 32, height: 36, alignItems: "center", justifyContent: "center" },
	settingLabel: { maxWidth: 105, height: 34, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 5 },
	settingText: { color: t.textTertiary, fontSize: 10 },
	send: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: t.blue, marginLeft: 7 },
	stop: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: t.bgSubtle, borderWidth: 1, borderColor: t.borderDefault, marginLeft: 7 },
	attachments: { gap: 7, paddingBottom: 7 },
	attachment: { maxWidth: 180, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: t.bgElevated, borderRadius: 9, borderWidth: 1, borderColor: t.borderSubtle, paddingHorizontal: 9, paddingVertical: 7 },
	attachmentImage: { width: 28, height: 28, borderRadius: 6, backgroundColor: t.bgSubtle },
	attachmentName: { flexShrink: 1, color: t.textSecondary, fontSize: 11 },
	deliveryChoice: { minHeight: 29, flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 2, marginTop: 3 },
	deliveryOption: { borderRadius: 7, paddingHorizontal: 8, paddingVertical: 5 },
	deliveryOptionSelected: { backgroundColor: t.bgSubtle },
	deliveryOptionText: { color: t.textTertiary, fontSize: 10, fontWeight: "600" },
	deliveryHint: { flex: 1, textAlign: "right", color: t.textFaint, fontSize: 9 },
	error: { color: t.red, fontSize: 11, lineHeight: 15, marginBottom: 6, paddingHorizontal: 3 },
	voice: { flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: t.tintRed, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 7, marginBottom: 7 },
	voiceText: { flex: 1, color: t.textSecondary, fontSize: 11 },
	scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: t.scrim },
	suggestionSheet: { position: "absolute", left: 0, right: 0, bottom: 0, height: "72%", borderTopLeftRadius: 22, borderTopRightRadius: 22, backgroundColor: t.bgSurface, paddingBottom: 30 },
	suggestionHeader: { flexDirection: "row", alignItems: "center", padding: 16, paddingBottom: 10 },
	suggestionTitle: { flex: 1, color: t.textPrimary, fontWeight: "700", fontSize: 17 },
	search: { marginHorizontal: 14, marginBottom: 8, minHeight: 42, backgroundColor: t.bgElevated, borderRadius: 10, color: t.textPrimary, paddingHorizontal: 12 },
	truncated: { color: t.amber, fontSize: 10, lineHeight: 14, paddingHorizontal: 16, paddingBottom: 7 },
	suggestionRow: { minHeight: 53, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.borderSubtle },
	suggestionLabel: { color: t.textPrimary, fontSize: 13, fontWeight: "600" },
	suggestionDetail: { color: t.textTertiary, fontSize: 11, lineHeight: 15, marginTop: 2 },
	badge: { color: t.textFaint, fontSize: 9, textTransform: "uppercase" },
	none: { color: t.textTertiary, fontSize: 13, textAlign: "center", paddingVertical: 30 },
});
