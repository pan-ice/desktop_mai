import { describe, expect, it } from "vitest";
import { emptySnapshot } from "../shared/defaults";
import {
  mergeAppliedVoiceDraft,
  mergeSettingsDraft,
} from "../shared/settings-draft";
import { chatMessageKey, historyViewChange } from "../shared/chat-history-view";
import { ttsProfile } from "../shared/tts";

describe("设置草稿与外部更新", () => {
  it("切换即时设置后保留未保存称呼，同时更新未编辑字段", () => {
    const saved = emptySnapshot().settings;
    const draft = { ...saved, nickname: "新称呼" };
    const incoming = { ...saved, alwaysOnTop: !saved.alwaysOnTop };
    expect(mergeSettingsDraft(draft, saved, incoming)).toEqual({
      ...incoming,
      nickname: "新称呼",
    });
  });

  it("保存一份表单后继续保留其他表单草稿", () => {
    const saved = emptySnapshot().settings;
    const draft = {
      ...saved,
      sttModel: "local-whisper",
      proactivePrompt: "尚未保存",
    };
    const incoming = { ...saved, sttModel: "local-whisper" };
    const merged = mergeSettingsDraft(draft, saved, incoming);
    expect(merged.sttModel).toBe("local-whisper");
    expect(merged.proactivePrompt).toBe("尚未保存");
    const external = { ...incoming, sttModel: "updated-whisper" };
    expect(mergeSettingsDraft(merged, incoming, external).sttModel).toBe(
      "updated-whisper",
    );
  });

  it("较早的保存结果不会覆盖请求期间的新输入", () => {
    const saved = emptySnapshot().settings;
    const draft = { ...saved, userName: "第二次编辑" };
    const incoming = { ...saved, userName: "第一次编辑" };
    expect(mergeSettingsDraft(draft, saved, incoming).userName).toBe(
      "第二次编辑",
    );
  });

  it("结构相同的对象值不被误判为脏字段", () => {
    const saved = emptySnapshot().settings;
    const draft = structuredClone(saved);
    const incoming = {
      ...saved,
      ttsProfiles: {
        ...saved.ttsProfiles,
        openai: {
          model: "model",
          voice: "voice",
          baseUrl: "http://127.0.0.1/v1",
          resourceId: "",
        },
      },
    };
    expect(mergeSettingsDraft(draft, saved, incoming).ttsProfiles).toEqual(
      incoming.ttsProfiles,
    );
    expect(mergeSettingsDraft(draft, saved, structuredClone(saved))).toBe(
      draft,
    );
  });

  it("即时开关保留多个服务商的端点和音色草稿及朗读模式", () => {
    const saved = emptySnapshot().settings;
    const draft = {
      ...saved,
      ttsEngine: "api" as const,
      ttsProvider: "mimo" as const,
      ttsProfiles: {
        ...saved.ttsProfiles,
        openai: {
          ...ttsProfile(saved, "openai"),
          baseUrl: "http://127.0.0.1:9100/v1",
          model: "draft-model",
          voice: "draft-openai-voice",
        },
        mimo: {
          ...ttsProfile(saved, "mimo"),
          voice: "draft-mimo-voice",
        },
      },
    };
    const incoming = { ...saved, voiceEnabled: !saved.voiceEnabled };
    const merged = mergeSettingsDraft(draft, saved, incoming);
    expect(merged.ttsEngine).toBe("api");
    expect(merged.ttsProvider).toBe("mimo");
    expect(merged.ttsProfiles).toEqual(draft.ttsProfiles);
    expect(merged.voiceEnabled).toBe(incoming.voiceEnabled);
  });

  it("声音保存响应保留后续编辑，提交后又能接收外部音色更新", () => {
    const saved = emptySnapshot().settings;
    const submitted = {
      ...saved,
      ttsProfiles: {
        openai: { ...ttsProfile(saved, "openai"), voice: "first-voice" },
      },
    };
    const draft = {
      ...submitted,
      ttsProfiles: {
        ...submitted.ttsProfiles,
        openai: {
          ...submitted.ttsProfiles.openai,
          voice: "second-voice",
          baseUrl: "http://127.0.0.1:9200/v1",
        },
        mimo: { ...ttsProfile(saved, "mimo"), voice: "another-draft" },
      },
    };
    const merged = mergeSettingsDraft(draft, saved, submitted);
    expect(merged.ttsProfiles).toEqual(draft.ttsProfiles);
    const savedAgain = structuredClone(draft);
    const committed = mergeSettingsDraft(merged, submitted, savedAgain);
    const external = {
      ...savedAgain,
      ttsProfiles: {
        ...savedAgain.ttsProfiles,
        mimo: { ...savedAgain.ttsProfiles.mimo, voice: "imported-voice" },
      },
    };
    expect(
      mergeSettingsDraft(committed, savedAgain, external).ttsProfiles,
    ).toEqual(external.ttsProfiles);
  });
});

describe("明确选用音色与声音草稿", () => {
  it("更新目标服务商，其他服务商的未保存草稿保留", () => {
    const saved = emptySnapshot().settings;
    const draft = {
      ...saved,
      speechVolume: 0.35,
      ttsProfiles: {
        openai: { ...ttsProfile(saved, "openai"), voice: "unsaved-openai" },
        mimo: { ...ttsProfile(saved, "mimo"), voice: "unsaved-mimo" },
      },
    };
    const applied = {
      ...saved,
      ttsEngine: "api" as const,
      ttsProvider: "mimo" as const,
      ttsProfiles: {
        mimo: { ...ttsProfile(saved, "mimo"), voice: "selected-mimo" },
      },
    };
    const merged = mergeAppliedVoiceDraft(draft, draft, applied);
    expect(merged.ttsEngine).toBe("api");
    expect(merged.ttsProvider).toBe("mimo");
    expect(merged.ttsProfiles.mimo).toEqual(applied.ttsProfiles.mimo);
    expect(merged.ttsProfiles.openai).toEqual(draft.ttsProfiles.openai);
    expect(merged.speechVolume).toBe(0.35);
    expect(applied.ttsProfiles).not.toHaveProperty("openai");
  });

  it("等候导入期间的新端点和服务商选择不会被完成回调覆盖", () => {
    const saved = emptySnapshot().settings;
    const beforeApply = {
      ...saved,
      ttsProfiles: {
        mimo: { ...ttsProfile(saved, "mimo"), voice: "previous-draft" },
      },
    };
    const draft = {
      ...beforeApply,
      ttsProvider: "siliconflow" as const,
      ttsProfiles: {
        mimo: {
          ...beforeApply.ttsProfiles.mimo,
          baseUrl: "http://127.0.0.1:9300/v1",
        },
      },
    };
    const applied = {
      ...saved,
      ttsEngine: "api" as const,
      ttsProvider: "mimo" as const,
      ttsProfiles: {
        mimo: {
          ...ttsProfile(saved, "mimo"),
          model: "mimo-v2.5-tts-voiceclone",
          voice: "imported-mimo",
        },
      },
    };
    const merged = mergeAppliedVoiceDraft(draft, beforeApply, applied);
    expect(merged.ttsProvider).toBe("siliconflow");
    expect(merged.ttsProfiles.mimo).toEqual({
      ...applied.ttsProfiles.mimo,
      baseUrl: "http://127.0.0.1:9300/v1",
    });
  });
});

describe("聊天列表的阅读位置", () => {
  it("补载旧消息不记为新消息，同时到达的最新消息单独计数", () => {
    expect(
      historyViewChange(
        ["user:2", "assistant:3"],
        ["user:1", "user:2", "assistant:3"],
      ),
    ).toEqual({
      reset: false,
      prepended: true,
      appended: 0,
    });
    expect(
      historyViewChange(
        ["user:2", "assistant:3"],
        ["user:1", "user:2", "assistant:3", "assistant:4"],
      ),
    ).toEqual({
      reset: false,
      prepended: true,
      appended: 1,
    });
  });

  it("达到本机记录上限后仍识别追加消息", () => {
    expect(historyViewChange(["1", "2", "3"], ["2", "3", "4"])).toEqual({
      reset: false,
      prepended: false,
      appended: 1,
    });
  });

  it("投递状态更新不新增消息，清空或切换会话会重置阅读位置", () => {
    expect(historyViewChange(["1", "2"], ["1", "2"])).toEqual({
      reset: false,
      prepended: false,
      appended: 0,
    });
    expect(historyViewChange(["1", "2"], []).reset).toBe(true);
    expect(historyViewChange(["1", "2"], ["3", "4"]).reset).toBe(true);
  });

  it("同 ID 的用户和助手消息仍有独立锚点", () => {
    expect(chatMessageKey({ id: "same", role: "user" })).not.toBe(
      chatMessageKey({ id: "same", role: "assistant" }),
    );
  });
});
