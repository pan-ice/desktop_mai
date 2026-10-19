import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createClonedVoice,
  queryClonedVoice,
  synthesizeTts,
} from "../electron/tts";
import { defaultSettings } from "../shared/defaults";
import {
  TTS_PROVIDERS,
  MIMO_REFERENCE_MAX_BYTES,
  ttsProfile,
  ttsProviders,
  type TtsProvider,
} from "../shared/tts";
import { speechSegments } from "../shared/speech-text";

const wav = Buffer.alloc(46);
wav.write("RIFF");
wav.writeUInt32LE(38, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(2, 40);
const audio = { name: "reference.wav", data: Uint8Array.from(wav).buffer };
type Captured = {
  path: string;
  headers: IncomingHttpHeaders;
  raw: string;
  body: any;
  form?: FormData;
};
let server: Server, base: string, requests: Captured[];
const directories: string[] = [];
async function referenceDirectory() {
  const root = resolve(".cache/tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "mimo-reference-"));
  directories.push(directory);
  return directory;
}
let respond: (request: Captured) => {
  status?: number;
  data: unknown;
  headers?: Record<string, string>;
};
beforeEach(async () => {
  requests = [];
  server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const captured: Captured = {
        path: req.url!,
        headers: req.headers,
        raw: bytes.toString(),
        body: undefined,
      };
      if (req.headers["content-type"]?.includes("application/json"))
        captured.body = JSON.parse(captured.raw);
      if (req.headers["content-type"]?.includes("multipart/form-data"))
        captured.form = await new Response(bytes, {
          headers: { "Content-Type": req.headers["content-type"] },
        }).formData();
      requests.push(captured);
      const reply = respond(captured);
      res.writeHead(reply.status ?? 200, reply.headers);
      res.end(
        Buffer.isBuffer(reply.data) || typeof reply.data === "string"
          ? reply.data
          : JSON.stringify(reply.data),
      );
    } catch {
      res.writeHead(500).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("测试服务未启动");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
function settings(provider: TtsProvider) {
  return {
    ...structuredClone(defaultSettings),
    ttsProvider: provider,
    speechRate: 1.2,
    ttsProfiles: {
      [provider]: {
        ...ttsProviders[provider].defaults,
        baseUrl: `${base}/${provider}`,
      },
    },
  };
}

describe("在线模型语音协议", () => {
  for (const provider of TTS_PROVIDERS)
    it(`${provider} 使用独立协议合成可播放音频`, async () => {
      respond = (req) => {
        if (req.path.startsWith("/result.wav")) return { data: wav };
        if (provider === "mimo")
          return {
            data: {
              choices: [
                {
                  finish_reason: "stop",
                  message: { audio: { data: wav.toString("base64") } },
                },
              ],
            },
          };
        if (provider === "minimax")
          return {
            data: {
              base_resp: { status_code: 0 },
              data: { audio: wav.toString("hex") },
            },
          };
        if (provider === "bailian")
          return {
            data: {
              output: { audio: { url: `${base}/result.wav?signature=kept` } },
            },
          };
        if (provider === "volcengine")
          return {
            data: [
              JSON.stringify({ code: 0, data: wav.toString("base64") }),
              JSON.stringify({ code: 20000000 }),
            ].join("\n"),
          };
        return { data: wav };
      };
      const config = settings(provider),
        profile = ttsProfile(config);
      expect(
        await synthesizeTts(config, `${provider}-secret`, "你好，麦麦。"),
      ).toBe(`data:audio/wav;base64,${wav.toString("base64")}`);
      const req = requests[0];
      if (provider === "volcengine") {
        expect(req.path).toBe("/volcengine/unidirectional");
        expect(req.headers["x-api-key"]).toBe("volcengine-secret");
        expect(req.headers["x-api-resource-id"]).toBe(profile.resourceId);
        expect(req.headers["x-api-request-id"]).toMatch(/^[a-f0-9-]{36}$/);
        expect(req.body.req_params).toEqual({
          text: "你好，麦麦。",
          speaker: profile.voice,
          model: profile.model,
          audio_params: { format: "mp3", sample_rate: 24000, speech_rate: 20 },
        });
      } else if (provider === "mimo") {
        expect(req.path).toBe("/mimo/chat/completions");
        expect(req.headers["api-key"]).toBe("mimo-secret");
        expect(req.headers.authorization).toBeUndefined();
        expect(req.body).toEqual({
          model: "mimo-v2.5-tts",
          messages: [{ role: "assistant", content: "你好，麦麦。" }],
          audio: { format: "wav", voice: "mimo_default" },
          stream: false,
        });
      } else {
        expect(req.headers.authorization).toBe(`Bearer ${provider}-secret`);
        if (provider === "minimax") {
          expect(req.path).toBe("/minimax/t2a_v2");
          expect(req.body).toMatchObject({
            model: profile.model,
            text: "你好，麦麦。",
            stream: false,
            output_format: "hex",
            voice_setting: { voice_id: profile.voice, speed: 1.2 },
          });
        } else if (provider === "bailian") {
          expect(req.path).toBe(
            "/bailian/services/audio/tts/SpeechSynthesizer",
          );
          expect(req.body).toEqual({
            model: profile.model,
            input: {
              text: "你好，麦麦。",
              voice: profile.voice,
              format: "wav",
              sample_rate: 24000,
              rate: 1.2,
            },
          });
          expect(requests[1].path).toBe("/result.wav?signature=kept");
          expect(requests[1].headers.authorization).toBeUndefined();
        } else {
          expect(req.path).toBe(`/${provider}/audio/speech`);
          expect(req.body).toEqual({
            model: profile.model,
            input: "你好，麦麦。",
            voice: profile.voice,
            response_format: "mp3",
            speed: 1.2,
          });
        }
      }
    });

  it("兼容火山 SSE，拒绝截断流和业务错误", async () => {
    respond = () => ({
      data: `event: 352\ndata: {"code":0,"data":"${wav.toString("base64")}"}\n\nevent: 152\ndata: {"code":20000000}\n`,
    });
    expect(
      await synthesizeTts(settings("volcengine"), "key", "测试"),
    ).toContain("data:audio/wav");
    respond = () => ({
      data: JSON.stringify({ code: 0, data: wav.toString("base64") }),
    });
    await expect(
      synthesizeTts(settings("volcengine"), "key", "测试"),
    ).rejects.toThrow("未完成");
    respond = () => ({
      data: { code: 45000000, message: "private provider details" },
    });
    await expect(
      synthesizeTts(settings("volcengine"), "key", "测试"),
    ).rejects.toThrow("45000000");
  });

  it("拒绝错误状态、假音频和异常编码，不暴露响应密钥", async () => {
    respond = () => ({ status: 401, data: { message: "secret-key" } });
    await expect(
      synthesizeTts(settings("siliconflow"), "secret-key", "测试"),
    ).rejects.toThrow("HTTP 401");
    respond = () => ({
      data: { base_resp: { status_code: 1002 }, message: "secret-key" },
    });
    await expect(
      synthesizeTts(settings("minimax"), "secret-key", "测试"),
    ).rejects.toThrow("状态 1002");
    respond = () => ({
      data: { base_resp: { status_code: 0 }, data: { audio: "abc" } },
    });
    await expect(
      synthesizeTts(settings("minimax"), "key", "测试"),
    ).rejects.toThrow("音频编码");
    respond = () => ({ data: Buffer.from('{"error":"secret-key"}') });
    await expect(
      synthesizeTts(settings("openai"), "key", "测试"),
    ).rejects.toThrow("可播放");
    respond = () => ({ headers: { "Content-Length": "30000000" }, data: wav });
    await expect(
      synthesizeTts(settings("openai"), "key", "测试"),
    ).rejects.toThrow("过大");
  });

  it("百炼不向非预期下载域或跳转目标外发请求", async () => {
    respond = () => ({
      data: {
        output: { audio: { url: "https://unexpected.invalid/sample.wav" } },
      },
    });
    await expect(
      synthesizeTts(settings("bailian"), "key", "测试"),
    ).rejects.toThrow("非预期");
    expect(requests).toHaveLength(1);
    respond = () => ({
      status: 302,
      headers: { Location: `${base}/redirected` },
      data: "",
    });
    await expect(
      synthesizeTts(settings("openai"), "key", "测试"),
    ).rejects.toThrow("无法连接");
    expect(requests).toHaveLength(2);
  });
});

describe("在线音色复刻", () => {
  it("MiMo 本机保存参考音频，重载后每次合成携带样本而非本机 ID", async () => {
    const directory = await referenceDirectory();
    const config = settings("mimo");
    const voice = await createClonedVoice(
      config,
      "",
      { name: "MiMo 参考音色", audio },
      directory,
    );
    expect(requests).toHaveLength(0);
    expect(voice).toMatchObject({
      provider: "mimo",
      status: "ready",
      profile: { model: "mimo-v2.5-tts-voiceclone" },
    });
    expect(voice.voiceId).toBe(`mimo-local:${voice.id}.wav`);
    expect(JSON.stringify(voice)).not.toContain(wav.toString("base64"));
    expect(
      await readFile(join(directory, "voice-references", `${voice.id}.wav`)),
    ).toEqual(wav);
    config.ttsProfiles.mimo = JSON.parse(JSON.stringify(voice.profile));
    respond = () => ({
      data: {
        choices: [
          {
            finish_reason: "stop",
            message: { audio: { data: wav.toString("base64") } },
          },
        ],
      },
    });
    for (const text of ["第一段", "第二段"]) {
      expect(
        await synthesizeTts(config, "mimo-only-key", text, directory),
      ).toContain("data:audio/wav");
    }
    for (const req of requests) {
      expect(req.path).toBe("/mimo/chat/completions");
      expect(req.body.audio).toEqual({
        format: "wav",
        voice: `data:audio/wav;base64,${wav.toString("base64")}`,
      });
      expect(req.body.model).toBe("mimo-v2.5-tts-voiceclone");
      expect(req.headers["api-key"]).toBe("mimo-only-key");
      expect(req.headers.authorization).toBeUndefined();
    }
    await rm(join(directory, "voice-references", `${voice.id}.wav`));
    await expect(
      synthesizeTts(config, "key", "文件已丢失", directory),
    ).rejects.toThrow("参考音频缺失");
  });

  it("MiMo 拒绝超出 Base64 上限的样本、不匹配格式、路径和缺少参考的复刻", async () => {
    const directory = await referenceDirectory();
    const config = settings("mimo");
    await expect(
      createClonedVoice(
        config,
        "",
        {
          name: "过大",
          audio: {
            name: "large.wav",
            data: new ArrayBuffer(MIMO_REFERENCE_MAX_BYTES + 1),
          },
        },
        directory,
      ),
    ).rejects.toThrow("超过");
    await expect(
      createClonedVoice(
        config,
        "",
        { name: "扩展名不符", audio: { ...audio, name: "reference.mp3" } },
        directory,
      ),
    ).rejects.toThrow("不符");
    config.ttsProfiles.mimo!.model = "mimo-v2.5-tts-voiceclone";
    config.ttsProfiles.mimo!.voice = "mimo-local:../../private.wav";
    await expect(
      synthesizeTts(config, "key", "无效本机引用", directory),
    ).rejects.toThrow("保存并选择");
    config.ttsProfiles.mimo!.voice = "mimo_default";
    await expect(
      synthesizeTts(config, "key", "未选择参考", directory),
    ).rejects.toThrow("保存并选择");
    expect(requests).toHaveLength(0);
  });

  it("MiMo 拒绝缺少音频、截断输出和业务错误", async () => {
    const config = settings("mimo");
    for (const data of [
      {
        choices: [
          {
            finish_reason: "length",
            message: { audio: { data: wav.toString("base64") } },
          },
        ],
      },
      { error: { message: "private-secret" } },
    ]) {
      respond = () => ({ data });
      await expect(synthesizeTts(config, "key", "不完整返回")).rejects.toThrow(
        "未完整完成",
      );
    }
    respond = () => ({
      data: { choices: [{ message: { content: "没有音频" } }] },
    });
    await expect(synthesizeTts(config, "key", "没有音频")).rejects.toThrow(
      "音频编码",
    );
    config.ttsProfiles.mimo!.model = "mimo-v2.5-tts-voicedesign";
    await expect(synthesizeTts(config, "key", "不支持的模式")).rejects.toThrow(
      "请选择",
    );
  });
  it("硅基流动上传参考音频与原文，合成时使用返回的 URI", async () => {
    respond = () => ({ data: { uri: "speech:custom:mai:123" } });
    const config = settings("siliconflow");
    const voice = await createClonedVoice(config, "sf-key", {
      name: "我的音色",
      referenceText: "参考音频原文",
      audio,
    });
    expect(voice).toMatchObject({
      status: "ready",
      voiceId: "speech:custom:mai:123",
      profile: {
        model: ttsProfile(config).model,
        voice: "speech:custom:mai:123",
      },
    });
    const req = requests[0];
    expect(req.path).toBe("/siliconflow/uploads/audio/voice");
    expect(req.form?.get("model")).toBe(ttsProfile(config).model);
    expect(req.form?.get("customName")).toBe("我的音色");
    expect(req.form?.get("text")).toBe("参考音频原文");
    const file = req.form?.get("file") as File;
    expect(Buffer.from(await file.arrayBuffer())).toEqual(wav);
    respond = () => ({ data: wav });
    config.ttsProfiles.siliconflow = voice.profile;
    await synthesizeTts(config, "sf-key", "试听");
    expect(requests[1].body.voice).toBe(voice.voiceId);
  });

  it("MiniMax 原样使用 int64 文件 ID，创建时不触发额外试听合成", async () => {
    respond = (req) =>
      req.path.endsWith("files/upload")
        ? {
            data: '{"file":{"file_id":9223372036854775806},"base_resp":{"status_code":0}}',
          }
        : { data: { base_resp: { status_code: 0 }, input_sensitive: false } };
    const voice = await createClonedVoice(settings("minimax"), "mm-key", {
      name: "麦麦",
      voiceId: "MaiVoice01",
      audio,
    });
    expect(voice.voiceId).toBe("MaiVoice01");
    expect(requests[0].form?.get("purpose")).toBe("voice_clone");
    expect(requests[1].raw).toBe(
      '{"voice_id":"MaiVoice01","file_id":9223372036854775806}',
    );
    expect(requests[1].body.text).toBeUndefined();
  });

  it("百炼提交公网参考链接，审核通过后保留指定模型", async () => {
    respond = (req) => ({
      data: {
        output:
          req.body.input.action === "create_voice"
            ? { voice_id: "qwen-custom-mai" }
            : {
                status: "OK",
                target_model: ttsProfile(settings("bailian")).model,
              },
      },
    });
    const voice = await createClonedVoice(settings("bailian"), "bl-key", {
      name: "麦麦",
      referenceUrl: "https://samples.example.com/ref.wav?signature=1",
    });
    expect(voice.status).toBe("pending");
    expect(requests[0].body).toMatchObject({
      model: "voice-enrollment",
      input: {
        action: "create_voice",
        prefix: "mai",
        url: "https://samples.example.com/ref.wav?signature=1",
        target_model: voice.profile.model,
      },
    });
    expect((await queryClonedVoice(voice, "bl-key")).status).toBe("ready");
    expect(requests[1].body.input).toEqual({
      action: "query_voice",
      voice_id: voice.voiceId,
    });
    respond = () => ({
      data: { output: { status: "OK", target_model: "another-model" } },
    });
    await expect(queryClonedVoice(voice, "bl-key")).rejects.toThrow(
      "目标模型不匹配",
    );
  });

  for (const voiceId of ["S_example01", "MaiCustom01"])
    it(`火山训练和查询 ${voiceId}，采用复刻资源`, async () => {
      respond = (req) => ({
        data: { status: req.path.endsWith("get_voice") ? 2 : 1 },
      });
      const voice = await createClonedVoice(settings("volcengine"), "vc-key", {
        name: "麦麦",
        voiceId,
        audio,
      });
      expect(voice.status).toBe("pending");
      expect(voice.profile.resourceId).toBe("seed-icl-2.0");
      const identity = voiceId.startsWith("S_")
        ? { speaker_id: voiceId }
        : { speaker_id: "custom_speaker_id", custom_speaker_id: voiceId };
      expect(requests[0].body).toEqual({
        ...identity,
        audio: { data: wav.toString("base64"), format: "wav" },
        language: 0,
      });
      expect((await queryClonedVoice(voice, "vc-key")).status).toBe("ready");
      expect(requests[1].body).toEqual(identity);
      expect(requests[1].headers["x-api-key"]).toBe("vc-key");
    });

  it("缺少原文、音频、Key 和无效 ID 在请求前报错", async () => {
    await expect(
      createClonedVoice(settings("siliconflow"), "key", {
        name: "麦麦",
        audio,
      }),
    ).rejects.toThrow("原文");
    await expect(
      createClonedVoice(settings("minimax"), "key", { name: "麦麦" }),
    ).rejects.toThrow("参考音频");
    await expect(
      createClonedVoice(settings("minimax"), "key", {
        name: "麦麦",
        audio,
        voiceId: "bad",
      }),
    ).rejects.toThrow("音色 ID");
    await expect(
      createClonedVoice(settings("volcengine"), "", { name: "麦麦", audio }),
    ).rejects.toThrow("API Key");
    await expect(
      createClonedVoice(settings("bailian"), "key", {
        name: "麦麦",
        referenceUrl: "file:///private.wav",
      }),
    ).rejects.toThrow("链接无效");
    expect(requests).toHaveLength(0);
  });
});

describe("长回复完整分段", () => {
  for (const provider of TTS_PROVIDERS)
    it(`${provider} 保留尾部和 emoji，遵守字符与字节限制`, () => {
      const text =
        "先说一句。" + "你好🙂".repeat(1600) + "\n最后一段仍需朗读。";
      const segments = speechSegments(text, provider);
      expect(segments.join("")).toBe(text);
      expect(segments.length).toBeGreaterThan(1);
      for (const segment of segments) {
        expect(segment.length).toBeLessThanOrEqual(1000);
        expect(Buffer.byteLength(segment)).toBeLessThanOrEqual(
          provider === "volcengine" ? 1000 : 3000,
        );
        expect(segment).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
      }
    });
});
