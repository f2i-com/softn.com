fn main() {
    tauri_build::build();
    test_manifest();
}

/// tauri-build gives the app's executable a manifest asking for Common
/// Controls 6, where the dialog plugin's TaskDialogIndirect lives. Test
/// executables are linked without it, and on Windows a test that builds a
/// (mock) app then fails to start (STATUS_ENTRYPOINT_NOT_FOUND). Tests only.
fn test_manifest() {
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc") {
        return;
    }
    let path = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("test.manifest");
    std::fs::write(
        &path,
        r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0"
        processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" />
    </dependentAssembly>
  </dependency>
</assembly>
"#,
    )
    .unwrap();
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}", path.display());
}
