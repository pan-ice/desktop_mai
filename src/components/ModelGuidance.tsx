import { ArrowUpRight, CircleHelp } from "lucide-react";
import {
  MODEL_GUIDANCE_CHECKED,
  modelGuideLinks,
  voiceServiceGuides,
} from "../../shared/model-guidance";
import { ttsProviders, type TtsProvider } from "../../shared/tts";

export function ModelGuidance() {
  return (
    <aside className="model-guidance" aria-label="模型原理与费用说明">
      <div className="model-guidance-heading">
        <CircleHelp size={18} />
        <div>
          <strong>模型怎么工作，哪些操作会产生费用？</strong>
          <p>
            系统语音无需云端合成 Key。在线服务由 API Key
            对应的账号结算，导入、试听与自动朗读都可能产生用量。
          </p>
        </div>
      </div>
      <details>
        <summary>了解调用流程、配置字段和省费方法</summary>
        <ol className="model-usage-flow">
          <li>
            <strong>听你说话 · 转写</strong>
            <p>
              录音发送给转写服务，转换成文字。云端通常按音频时长或 Token
              计费；测试麦克风也会调用转写。
            </p>
          </li>
          <li>
            <strong>思考与回复 · MaiBot</strong>
            <p>
              文字和你分享的图片交给 MaiBot。聊天与视觉模型由 MaiBot
              或服务器服务方配置，相关模型费用单独结算。
            </p>
          </li>
          <li>
            <strong>把回复读出来 · 语音合成</strong>
            <p>
              系统声音使用系统提供的朗读能力；在线声音把回复正文发给所选服务生成音频。音色复刻还可能有创建或首次使用费用。
            </p>
          </li>
        </ol>
        <dl className="model-guide-fields">
          <div>
            <dt>服务地址</dt>
            <dd>
              决定文字或录音发送到哪里；使用中转地址时，价格和额度以该平台为准。
            </dd>
          </div>
          <div>
            <dt>API Key</dt>
            <dd>
              服务商的访问凭证，也决定使用哪个账号的额度。转写与合成分别配置，每家服务商分别保存。
            </dd>
          </div>
          <div>
            <dt>模型与音色</dt>
            <dd>
              模型 ID
              选择合成或转写能力，需与服务商接口匹配；音色选择朗读声音。聊天的人格和思考模型在
              MaiBot 中配置。
            </dd>
          </div>
          <div>
            <dt>用量单位</dt>
            <dd>
              字符、UTF-8 字节、Token
              和音频分钟数不是同一单位。估算费用时，用对应单位的用量乘以官方单价，并单独计算复刻或槽位费用。
            </dd>
          </div>
        </dl>
        <p>
          单纯保存地址、模型和 Key
          不调用合成或转写。试听、重新朗读会再次合成；播放聊天里已有的音频不调用本页的合成服务。
        </p>
        <p>
          想减少用量，可以用文字输入、选择系统语音，或关闭自动朗读和连续语音；拉长自动屏幕陪伴间隔可减少图片请求。停止播放会取消待播内容，已发送的请求仍可能计费。
        </p>
        <p className="model-guide-footnote">
          默认使用模型原生输出；关闭原生输出后启用的自然语气指令可能计入输入用量。长回复可预先合成下一段，停止时已提交的预合成仍可能计费；可在声音设置中关闭。
          本页不读取实时余额或实际账单。请在服务商控制台查看用量、套餐到期时间，并设置余额提醒或消费限额（如支持）。
        </p>
      </details>
    </aside>
  );
}

export function VoiceServiceGuidance({
  provider,
  importing = false,
}: {
  provider: TtsProvider;
  importing?: boolean;
}) {
  const guide = voiceServiceGuides[provider];
  return (
    <aside
      className="voice-service-guidance"
      aria-label={`${ttsProviders[provider].name}原理与费用`}
    >
      <strong>
        {importing ? "导入前，了解原理与费用" : "当前服务的原理与费用"}
      </strong>
      {!importing && <p>{guide.summary}</p>}
      <details>
        <summary>查看原理、计费方式与官方价格</summary>
        <p>{guide.principle}</p>
        <dl className="model-guide-fields">
          {importing && (
            <div>
              <dt>导入时</dt>
              <dd>{guide.preparation}</dd>
            </div>
          )}
          <div>
            <dt>朗读时</dt>
            <dd>{guide.billing}</dd>
          </div>
        </dl>
        <div className="model-guide-links">
          <a
            href={modelGuideLinks[provider]}
            target="_blank"
            rel="noreferrer noopener"
          >
            {provider === "openai"
              ? "OpenAI 默认模型价格"
              : "查看官方价格与计费规则"}
            <ArrowUpRight size={13} />
          </a>
          {provider === "volcengine" && (
            <a
              href={modelGuideLinks.volcengineClone}
              target="_blank"
              rel="noreferrer noopener"
            >
              音色槽位说明
              <ArrowUpRight size={13} />
            </a>
          )}
        </div>
      </details>
      <small>
        规则核对：{MODEL_GUIDANCE_CHECKED} ·
        实际费用以所用平台、模型、地域与账号权益为准。
      </small>
    </aside>
  );
}
