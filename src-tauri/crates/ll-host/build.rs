fn main() {
    // ── Windows：给测试二进制嵌入 Common-Controls v6 清单 ──────────────────
    // 背景：本 crate 依赖 tauri → 间接静态导入 comctl32!TaskDialogIndirect。
    // 该导出只存在于 comctl32 v6，而 v6 必须靠进程内嵌的依赖声明
    // （Microsoft.Windows.Common-Controls 6.0.0.0）经 SxS 激活。
    // 主程序 LiteLauncher.exe 的清单由 tauri-build 经 embed_resource 的
    // `link-arg-bins` 嵌入——只覆盖 bin 目标；cargo test 的测试二进制
    // （ll_host-<hash>.exe）没有清单 → 加载器绑定 System32 的 comctl32 v5
    // → 进程启动即 0xC0000139 (STATUS_ENTRYPOINT_NOT_FOUND)，一个测试都跑不起来。
    //
    // 修复：用 `cargo:rustc-link-arg`（compile_for_everything）把同一份清单
    // 链接进所有目标。不能用 compile_for_tests：`cargo:rustc-link-arg-tests`
    // 只认 tests/ 集成测试目标，lib 单测二进制不在其列，且包内没有该类目标
    // 时 Cargo 直接报错。本 crate 无 bin，不存在与 tauri-build 清单重复的问题。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    // 与 tauri-build 的 windows-app-manifest.xml 同源：仅声明 Common-Controls 6 依赖。
    let manifest_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#;

    let out_dir = std::env::var("OUT_DIR").expect("build script: no OUT_DIR");
    let xml_path = std::path::Path::new(&out_dir).join("test-manifest.xml");
    let rc_path = std::path::Path::new(&out_dir).join("test-manifest.rc");
    std::fs::write(&xml_path, manifest_xml).expect("build script: write test-manifest.xml");
    // RT_MANIFEST(24)、ID 1（CREATEPROCESS_MANIFEST_RESOURCE_ID）。资源文件内引用
    // 用绝对路径（统一正斜杠），windres / llvm-rc / rc.exe 都接受。
    let rc_content = format!(
        "1 24 \"{}\"\n",
        xml_path.to_string_lossy().replace('\\', "/")
    );
    std::fs::write(&rc_path, rc_content).expect("build script: write test-manifest.rc");

    let _ = embed_resource::compile_for_everything(&rc_path, embed_resource::NONE);
}
