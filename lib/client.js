// client.js — Browser & Electron Client Plugin for JevAgent
// Registers Quick Toggle Bar into DSH Chat and "Jev API 设置" section into Settings

window.__ModuleLoader__.load({
  id: "dsh-plugin-jevagent",
  factory: (require) => {
    const React = require("react");
    const { useState, useEffect, createElement: h } = React;

    const name = "client-jevagent";
    const inject = ["slots"];

    // Helper toggle switch UI
    function ToggleSwitch({ checked, onChange, label, sublabel, disabled = false }) {
      return h("div", {
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
          padding: "6px 0"
        }
      }, [
        h("div", { style: { display: "flex", flexDirection: "column", gap: "2px", flex: 1 } }, [
          h("div", { style: { fontSize: "13px", fontWeight: 600, color: "inherit" } }, label),
          sublabel && h("div", { style: { fontSize: "11.5px", opacity: 0.65, lineHeight: "1.4" } }, sublabel)
        ]),
        h("button", {
          role: "switch",
          "aria-checked": String(checked),
          disabled: disabled,
          onClick: () => !disabled && onChange(!checked),
          style: {
            position: "relative",
            width: "42px",
            height: "22px",
            borderRadius: "11px",
            border: "none",
            cursor: disabled ? "not-allowed" : "pointer",
            flexShrink: 0,
            transition: "background 0.2s",
            background: checked ? "#3b82f6" : "rgba(128,128,128,0.35)",
            opacity: disabled ? 0.5 : 1,
            padding: 0
          }
        }, [
          h("span", {
            style: {
              position: "absolute",
              top: "2px",
              left: "2px",
              width: "18px",
              height: "18px",
              borderRadius: "50%",
              background: "#ffffff",
              boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
              transition: "transform 0.2s",
              transform: checked ? "translateX(20px)" : "translateX(0)",
              display: "block"
            }
          })
        ])
      ]);
    }

    // 1. Conversation Chat Interface Quick Toggle Bar (在当前对话界面直接点击开关)
    function JevChatQuickBar() {
      const [config, setConfig] = useState({
        allow_direct_code_write: false,
        jev_enabled: true
      });
      const [toggling, setToggling] = useState(false);

      const fetchStatus = async () => {
        try {
          const res = await fetch("/api-jevagent/config");
          if (res.ok) {
            const data = await res.json();
            if (data.ok && data.config) {
              setConfig({
                allow_direct_code_write: Boolean(data.config.allow_direct_code_write),
                jev_enabled: Boolean(data.config.jev_enabled)
              });
            }
          }
        } catch {}
      };

      useEffect(() => {
        fetchStatus();
        const timer = setInterval(fetchStatus, 5000);
        return () => clearInterval(timer);
      }, []);

      const toggleWriteProtect = async () => {
        if (toggling) return;
        setToggling(true);
        const nextVal = !config.allow_direct_code_write;
        try {
          const res = await fetch("/api-jevagent/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ allow_direct_code_write: nextVal })
          });
          if (res.ok) {
            setConfig(prev => ({ ...prev, allow_direct_code_write: nextVal }));
          }
        } catch {}
        finally {
          setToggling(false);
        }
      };

      const toggleJevEnabled = async () => {
        if (toggling) return;
        setToggling(true);
        const nextVal = !config.jev_enabled;
        try {
          const res = await fetch("/api-jevagent/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jev_enabled: nextVal })
          });
          if (res.ok) {
            setConfig(prev => ({ ...prev, jev_enabled: nextVal }));
          }
        } catch {}
        finally {
          setToggling(false);
        }
      };

      const isProtected = !config.allow_direct_code_write;

      return h("div", {
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          padding: "4px 10px",
          borderRadius: "20px",
          background: isProtected ? "rgba(16, 185, 129, 0.12)" : "rgba(239, 68, 68, 0.14)",
          border: `1px solid ${isProtected ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.35)"}`,
          fontSize: "12px",
          margin: "2px 4px",
          userSelect: "none"
        }
      }, [
        // Code Write Guard Toggle Button
        h("button", {
          type: "button",
          onClick: toggleWriteProtect,
          title: isProtected ? "点击临时放行 AI 直接写代码文件权限" : "点击立即恢复代码强保护门禁",
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: isProtected ? "#10b981" : "#ef4444",
            fontWeight: 600,
            fontSize: "12px",
            padding: 0
          }
        }, [
          h("span", { style: { fontSize: "13px" } }, isProtected ? "🛡️ 代码保护: 开启" : "⚠️ 代码直写: 已放行"),
          h("span", { style: { opacity: 0.7, fontSize: "11px", textDecoration: "underline" } }, isProtected ? "(点击放行)" : "(点击锁定)")
        ]),

        h("span", { style: { opacity: 0.3, color: "inherit" } }, "|"),

        // Jev Decision Switch
        h("button", {
          type: "button",
          onClick: toggleJevEnabled,
          title: config.jev_enabled ? "点击切换为本地纯确定性规则" : "点击连接远程 Jev 4B 决策模型",
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: config.jev_enabled ? "#3b82f6" : "rgba(128,128,128,0.7)",
            fontSize: "12px",
            padding: 0
          }
        }, [
          h("span", {}, config.jev_enabled ? "🤖 Jev 4B: 在线" : "🤖 Jev: 离线")
        ]),

        h("span", { style: { opacity: 0.3, color: "inherit" } }, "|"),

        // Fence status tag
        h("span", {
          title: "安全围栏配置自保护锁定中，AI 无法通过工具篡改 jevagent.json",
          style: {
            fontSize: "11px",
            opacity: 0.75,
            display: "inline-flex",
            alignItems: "center",
            gap: "2px"
          }
        }, "🔒 围栏锁定")
      ]);
    }

    // 2. Settings Dialog Full Section
    function JevSettingsSection() {
      const [config, setConfig] = useState({
        jev_enabled: true,
        jev_base_url: "",
        jev_api_key: "",
        jev_model: "jevk5-4b-v0.3-Q4_K_M",
        jev_timeout_s: 30,
        tables_dir: "",
        allow_direct_code_write: false,
        guard_extension_rename: true,
        guard_fence_config: true,
        anti_passthrough: true
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
            setNotice({ type: "success", text: "✓ JevAgent 安全围栏与 API 设置已保存并即时生效（已同步至 ~/.dsh/jevagent.json）" });
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
        opacity: 0.65,
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
          h("div", { style: { fontSize: "16px", fontWeight: 600 } }, "JevAgent 安全围栏与决策模型设置"),
          h("div", { style: subLabelStyle }, "DSL 是逻辑承载层与语法剥离层。本面板集中控制安全围栏、代码防篡改与 Jev 4B 决策服务。")
        ]),

        // Card 1: FENCE PROTECTION SWITCHES (新增：安全围栏核心直接开关)
        h("div", { key: "fenceCard", style: { ...cardStyle, border: "1px solid rgba(59, 130, 246, 0.35)", background: "rgba(59, 130, 246, 0.04)" } }, [
          h("div", { style: { ...labelStyle, color: "#3b82f6", display: "flex", alignItems: "center", gap: "6px" } }, [
            h("span", {}, "🛡️ 安全围栏与代码写保护控制"),
            h("span", { style: { fontSize: "11px", fontWeight: 400, opacity: 0.8 } }, "(人类专属门禁开关)")
          ]),

          ToggleSwitch({
            checked: !config.allow_direct_code_write,
            onChange: (protectEnabled) => setConfig({ ...config, allow_direct_code_write: !protectEnabled }),
            label: "代码防写强保护门禁 (JevGuard Code Protection)",
            sublabel: !config.allow_direct_code_write
              ? "当前状态：已开启【强保护模式】。AI 严禁直接修改或创建代码文件，必须使用特化 DSL 二文件模型生成代码。"
              : "⚠️ 当前状态：已临时放行！AI 允许直接调用工具修改代码文件。完成后建议及时开启保护。"
          }),

          ToggleSwitch({
            checked: config.guard_extension_rename,
            onChange: (val) => setConfig({ ...config, guard_extension_rename: val }),
            label: "源码后缀名防改保护 (Extension Rename Evasion Guard)",
            sublabel: "阻断一切试图将代码文件改名脱壳、将非代码改名为代码潜入，或通过命令行 (pwsh/bash) 重定向覆写代码文件的行为。"
          }),

          ToggleSwitch({
            checked: config.guard_fence_config,
            onChange: (val) => setConfig({ ...config, guard_fence_config: val }),
            label: "安全围栏配置文件自保护 (Fence Config Protection)",
            sublabel: "严禁 AI 使用任何工具修改 jevagent.json 及插件底层代码。围栏配置仅允许人类外部修改或在当前面板启停。"
          }),

          ToggleSwitch({
            checked: config.anti_passthrough,
            onChange: (val) => setConfig({ ...config, anti_passthrough: val }),
            label: "反语法偷渡与纯逻辑约束 (Anti-Passthrough Gate)",
            sublabel: "强制将 DSL 中偷渡的目标语言原生语句（如 if, def, print, const 等）自动纠偏转换为纯逻辑 DSL 规范节点。"
          })
        ]),

        // Card 2: Independent Jev Model Toggle Switch
        h("div", { key: "toggleCard", style: { ...cardStyle, flexDirection: "row", alignItems: "center", justifyContent: "space-between" } }, [
          h("div", { style: { display: "flex", flexDirection: "column", gap: "3px", flex: 1, paddingRight: "16px" } }, [
            h("div", { style: labelStyle }, "启用独立 Jev 决策模型 API"),
            h("div", { style: subLabelStyle }, config.jev_enabled
              ? "当前状态：已开启。特化路由、符号判断与语法校验将向 Jev 4B 模型发起结构化请求。"
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

        // Card 3: Connection Inputs
        h("div", { key: "connCard", style: cardStyle }, [
          h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } }, [
            h("div", { style: labelStyle }, "Jev API 接口地址 (Base URL)"),
            h("div", { style: subLabelStyle }, "连接到运行 JevK5 或原生 Jev 的 API 服务端点"),
            h("input", {
              type: "text",
              value: config.jev_base_url || "",
              placeholder: "例如 http://127.0.0.1:8199 或远程端点",
              onChange: (e) => setConfig({ ...config, jev_base_url: e.target.value }),
              style: inputStyle
            })
          ]),

          h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } }, [
            h("div", { style: labelStyle }, "Jev API 独立密钥 (API Key)"),
            h("div", { style: subLabelStyle }, "Jev 决策模型专属密钥（与通用 AI 密钥物理隔离）"),
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

        // Notification Banner
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
      // 1. Inject Settings Section into DSH Settings dialog
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

      // 2. Inject Direct Quick Switch Bar into Chat Controls & Toolbar (当前对话界面快捷开关)
      const chatSlots = ["chat.controls", "chat.toolbar", "chat.input.toolbar", "status.bar"];
      for (const slotName of chatSlots) {
        try {
          ctx.slots.inject(slotName, () => {
            return ctx.slots.register(
              {
                name: slotName,
                id: "jevagent-chat-quickbar",
                order: 10,
                inject: () => ({})
              },
              JevChatQuickBar
            );
          });
        } catch {}
      }
    }

    return { name, inject, apply };
  }
});
