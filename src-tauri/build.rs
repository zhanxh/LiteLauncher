fn main() {
    // Windows 图标由 tauri-build 编入 exe 资源段（.res）。若不显式声明，
    // icon.ico 内容变更不会触发构建脚本重跑，缓存里的旧资源会被继续
    // 链接进新 exe（表现为：源码已换图标，编译产物仍是旧图标）。
    println!("cargo:rerun-if-changed=icons/icon.ico");

    // ── Windows：清单统一由下面的 embed_resource 提供 ─────────────────────
    // 背景：tauri → muda 静态导入 comctl32!TaskDialogIndirect（仅 comctl32
    // v6 有此导出，v6 需进程内嵌 Common-Controls 依赖声明经 SxS 激活）。
    // tauri-build 默认经 `cargo:rustc-link-arg-bins` 只给 bin 目标嵌清单，
    // cargo test 的测试二进制（tauri_app_lib-<hash>.exe，含 src/ll_plugin_assets.rs
    // 的单测）没有清单 → 绑定 System32 comctl32 v5 → 启动即 0xC0000139
    // (STATUS_ENTRYPOINT_NOT_FOUND)。
    //
    // 处理：让 tauri-build 不再嵌清单（new_without_app_manifest，图标/版本
    // 信息照常），改用 `cargo:rustc-link-arg`（compile_for_everything）把
    // 同一份清单链接进 bin 与测试目标——单一清单来源，避免同一二进制内
    // 出现两份 RT_MANIFEST（MSVC 链接器会报重复资源）。
    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let attributes = if windows {
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
    } else {
        tauri_build::Attributes::new()
    };
    tauri_build::try_build(attributes).expect("failed to run tauri-build");

    if windows {
        // 与 tauri-build 内置 windows-app-manifest.xml 同源：仅声明
        // Common-Controls 6 依赖（DPI 等由 Tauri 运行时自行处理，无需清单项）。
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
        let xml_path = std::path::Path::new(&out_dir).join("app-manifest.xml");
        let rc_path = std::path::Path::new(&out_dir).join("app-manifest.rc");
        std::fs::write(&xml_path, manifest_xml).expect("build script: write app-manifest.xml");
        // RT_MANIFEST(24)、ID 1（CREATEPROCESS_MANIFEST_RESOURCE_ID）。资源文件内
        // 引用用绝对路径（统一正斜杠），windres / llvm-rc / rc.exe 都接受。
        let rc_content = format!(
            "1 24 \"{}\"\n",
            xml_path.to_string_lossy().replace('\\', "/")
        );
        std::fs::write(&rc_path, rc_content).expect("build script: write app-manifest.rc");
        let _ = embed_resource::compile_for_everything(&rc_path, embed_resource::NONE);

        // 本地 MinGW（windows-gnu）工具链：本包 cdylib 没有 #[no_mangle] 导出，
        // ld 回退 auto-export-all，把 257 个直接列出的目标文件里的全部符号
        // （约 15.7 万个）塞进导出表，超过 PE 导出序号 65535 上限 →
        // "export ordinal too large: 157129"。桌面端 cdylib 无消费方
        // （bin 静态链接 rlib），排除全部导出即可。MSVC 链接器无此回退行为，
        // 且不认识 GNU 语法，必须限 gnu 目标。
        if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu") {
            println!("cargo:rustc-link-arg-cdylib=-Wl,--exclude-all-symbols");
        }
    }
}
