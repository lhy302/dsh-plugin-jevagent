// client.js — Browser & Electron Client Plugin for JevAgent
// Registers "Jev API 设置" section into DSH Settings sidebar (settings.section slot)

window.__ModuleLoader__.load({
  id: "dsh-plugin-jevagent",
  factory: (require) => {
    const React = require("react");
    const { useState, useEffect, createElement: h } = React;

    const name = "client-jevagent";
    const inject = ["slots"];

    // Native DSH styled components for JevAgent Settings
    function JevSettingsSection() {
      const [config, setConfig] = useState({
        jev_enabled: true,
        jev_base_url: "",
        jev_api_key: "",
        jev_model: "jevk5-4b-v0.3-Q4_K_M",
        jev_timeout_s: 30,
        tables_dir: ""
      });

      const [showKey, setShowKey] = useState(false);
      const [loading, setLoading] = useState(true);
      const [saving, setSaving] = useState(false);
      const [testing, setTesting] = useState(false);
      const [notice, setNotice] = useState(null);

      const fetchConfig = async () => {
        try {
          setLoading(true);
          const res = await fetch("/api-jevagent/config");
          if (res.ok) {
            const data = await res.json();
            if (data.ok && data.config) {
              setConfig((prev) => ({
                ...prev,
                ...data.config,
                jev_api_key: data.config.jev_api_key && data.config.jev_api_key !== "configured" ? data.config.jev_api_key : prev.jev_api_key
              }));
            }
          }
        } catch (err) {
          // fallback
        } finally {
          setLoading(false);
        }
      };

      useEffect(() => {
        fetchConfig();
      }, []);

      const handleSave = async () => {
        try {
          setSaving(true);
          setNotice(null);
          const res = await fetch("/api-jevagent/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(config)
          });
          const data = await res.json();
          if (data.ok) {
            setNotice({ type: "success", text: "✓ Jev API 设置已保存并即时生效（已同步至 ~/.dsh/jevagent.json）" });
          } else {
            setNotice({ type: "error", text: "保存失败: " + (data.error || "未知错误") });
          }
        } catch (err) {
          setNotice({ type: "error", text: "网络请求失败: " + err.message });
        } finally {
          setSaving(false);
        }
      };

      const handleTest = async () => {
        try {
          setTesting(true);
          setNotice(null);
          const res = await fetch("/api-jevagent/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jev_base_url: config.jev_base_url,
              jev_api_key: config.jev_api_key,
              jev_model: config.jev_model
            })
          });
          const data = await res.json();
          if (data.ok && data.status === "connected") {
            setNotice({
              type: "success",
              text: `✓ Jev 决策接口连接成功！端点: ${data.endpoint_used || "远程端点"}，时延: ${data.latency_ms}ms`
            });
          } else {
            setNotice({
              type: "error",
              text: `✗ 接口测试未连通 (已降级): ${data.error || "服务未响应"}`
            });
          }
        } catch (err) {
          setNotice({ type: "error", text: "无法连接测试端点: " + err.message });
        } finally {
          setTesting(false);
        }
      };

      const cardStyle = {
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        padding: "14px 16px",
        border: "1px solid rgba(128,128,128,0.22)",
        borderRadius: "12px",
        background: "rgba(128,128,128,0.06)"
      };

      const inputStyle = {
        background: "rgba(128,128,128,0.12)",
        color: "inherit",
        border: "1px solid rgba(128,128,128,0.28)",
        borderRadius: "8px",
        padding: "7px 10px",
        fontSize: "13px",
        outline: "none",
        width: "100%",
        boxSizing: "border-box"
      };

      const labelStyle = {
        fontSize: "13px",
        fontWeight: 600,
        color: "inherit"
      };

      const subLabelStyle = {
        fontSize: "11.5px",
        opacity: 0.6,
        lineHeight: "1.4"
      };

      return h("div", {
        style: {
          padding: "20px 24px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          maxWidth: "680px",
          fontSize: "13px",
          color: "inherit"
        }
      }, [
        // Header
        h("div", { key: "header", style: { display: "flex", flexDirection: "column", gap: "4px" } }, [
          h("div", { style: { fontSize: "16px", fontWeight: 600 } }, "Jev 决策模型与 API 设置"),
          h("div", { style: subLabelStyle }, "依据《JevAgent 工程落地稿 V2.0》第 14.3 节与第 4.1 节：实现双 API 独立配置与物理隔离，面向 Choice / Score / Noul 候选内决策。")
        ]),

        // Card 1: Independent Toggle Switch
        h("div", { key: "toggleCard", style: { ...cardStyle, flexDirection: "row", alignItems: "center", justifyContent: "space-between" } }, [
          h("div", { style: { display: "flex", flexDirection: "column", gap: "3px", flex: 1, paddingRight: "16px" } }, [
            h("div", { style: labelStyle }, "启用独立 Jev 决策模型 API"),
            h("div", { style: subLabelStyle }, config.jev_enabled
              ? "当前状态：已开启。特化路由、符号判断与语法校验将向 Jev 模型发起结构化请求。"
              : "当前状态：已关闭。系统自动降级为本地确定性规则与内置树表（完全离线可用，不发网络请求）。")
          ]),
          h("button", {
            role: "switch",
            "aria-checked": String(config.jev_enabled),
            onClick: () => setConfig(prev => ({ ...prev, jev_enabled: !prev.jev_enabled })),
            style: {
              position: "relative",
              width: "44px",
              height: "24px",
              borderRadius: "12px",
              border: "none",
              cursor: "pointer",
              flexShrink: 0,
              transition: "background 0.2s",
              background: config.jev_enabled ? "#3b82f6" : "rgba(128,128,128,0.4)",
              padding: 0
            }
          }, [
            h("span", {
              style: {
                position: "absolute",
                top: "3px",
                left: "3px",
                width: "18px",
                height: "18px",
                borderRadius: "50%",
                background: "#ffffff",
                boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                transition: "transform 0.2s",
                transform: config.jev_enabled ? "translateX(20px)" : "translateX(0)",
                display: "block"
              }
            })
          ])
        ]),

        // Card 2: Connection Inputs
        h("div", { key: "connCard", style: cardStyle }, [
          // Base URL
          h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } }, [
            h("div", { style: labelStyle }, "Jev API 接口地址 (Base URL)"),
            h("div", { style: subLabelStyle }, "连接到运行 JevK5 或原生 Jev 的 API 服务，留空则默认使用本地确定性规则"),
            h("input", {
              type: "text",
              value: config.jev_base_url || "",
              placeholder: "例如 http://127.0.0.1:8199 或自定义端点（留空走本地）",
              onChange: (e) => setConfig({ ...config, jev_base_url: e.target.value }),
              style: inputStyle
            })
          ]),

          // API Key with show/hide toggle
          h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } }, [
            h("div", { style: labelStyle }, "Jev API 独立密钥 (API Key)"),
            h("div", { style: subLabelStyle }, "Jev 决策模型专属密钥（与通用 AI 密钥物理隔离，保存在 ~/.dsh/jevagent.json）"),
            h("div", { style: { display: "flex", gap: "8px" } }, [
              h("input", {
                type: showKey ? "text" : "password",
                value: config.jev_api_key,
                placeholder: "留空表示本地无鉴权",
                onChange: (e) => setConfig({ ...config, jev_api_key: e.target.value }),
                style: { ...inputStyle, flex: 1 }
              }),
              h("button", {
                type: "button",
                onClick: () => setShowKey(!showKey),
                style: {
                  background: "rgba(128,128,128,0.18)",
                  color: "inherit",
                  border: "none",
                  borderRadius: "8px",
                  padding: "0 12px",
                  cursor: "pointer",
                  fontSize: "12px"
                }
              }, showKey ? "隐藏" : "显示")
            ])
          ]),

          // Model Name
          h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } }, [
            h("div", { style: labelStyle }, "Jev 决策模型标识 (Model)"),
            h("div", { style: subLabelStyle }, "指定调用的 Jev 候选内决策小模型（如 jevk5-4b-v0.3-Q4_K_M）"),
            h("input", {
              type: "text",
              value: config.jev_model,
              placeholder: "jevk5-4b-v0.3-Q4_K_M",
              onChange: (e) => setConfig({ ...config, jev_model: e.target.value }),
              style: inputStyle
            })
          ]),

          // Timeout & Tables Dir in a 2-column grid
          h("div", { style: { display: "flex", gap: "12px" } }, [
            h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", flex: "0 0 140px" } }, [
              h("div", { style: labelStyle }, "请求超时时间 (秒)"),
              h("input", {
                type: "number",
                value: config.jev_timeout_s,
                onChange: (e) => setConfig({ ...config, jev_timeout_s: Number(e.target.value) }),
                style: inputStyle
              })
            ]),
            h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", flex: 1 } }, [
              h("div", { style: labelStyle }, "路由表存储目录 (Tables Dir)"),
              h("input", {
                type: "text",
                value: config.tables_dir || "",
                placeholder: "默认使用插件内置 tables 目录",
                onChange: (e) => setConfig({ ...config, tables_dir: e.target.value }),
                style: inputStyle
              })
            ])
          ])
        ]),

        // Notification Banner if any
        notice && h("div", {
          key: "notice",
          style: {
            padding: "10px 14px",
            borderRadius: "8px",
            fontSize: "12.5px",
            lineHeight: "1.5",
            background: notice.type === "success" ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
            border: `1px solid ${notice.type === "success" ? "rgba(34,197,94,0.35)" : "rgba(239,68,68,0.35)"}`,
            color: notice.type === "success" ? "#4ade80" : "#f87171"
          }
        }, notice.text),

        // Action Buttons
        h("div", { key: "actions", style: { display: "flex", gap: "10px", marginTop: "4px" } }, [
          h("button", {
            type: "button",
            disabled: saving,
            onClick: handleSave,
            style: {
              background: "#3b82f6",
              color: "#ffffff",
              border: "none",
              borderRadius: "8px",
              padding: "8px 18px",
              cursor: saving ? "wait" : "pointer",
              fontWeight: 600,
              fontSize: "13px",
              opacity: saving ? 0.7 : 1
            }
          }, saving ? "正在保存..." : "保存设置"),

          h("button", {
            type: "button",
            disabled: testing,
            onClick: handleTest,
            style: {
              background: "rgba(128,128,128,0.18)",
              color: "inherit",
              border: "1px solid rgba(128,128,128,0.28)",
              borderRadius: "8px",
              padding: "8px 18px",
              cursor: testing ? "wait" : "pointer",
              fontSize: "13px",
              opacity: testing ? 0.7 : 1
            }
          }, testing ? "正在测试..." : "测试连接")
        ])
      ]);
    }

    function apply(ctx) {
      // Inject JevAgent setting page into the DSH Settings dialog's left navigation
      ctx.slots.inject("settings.section", () => {
        return ctx.slots.register(
          {
            name: "settings.section",
            id: "jevagent-settings",
            order: 35,
            label: () => "Jev API 设置",
            inject: () => ({})
          },
          JevSettingsSection
        );
      });
    }

    return { name, inject, apply };
  }
});
