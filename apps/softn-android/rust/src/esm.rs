//! OXC AST-based ES Module graph linker for SoftN v2 containers on `zipp-vm`.
//!
//! Derived from `zipp-browser`'s `esm.rs` and extended with:
//! - Virtual `softn:*` capability modules (`softn:device`, `softn:camera`,
//!   `softn:bluetooth`, `softn:location`, `softn:haptics`, `softn:notifications`,
//!   `softn:db`, `softn:storage`, `softn:sqlite`, `softn:net`, `softn:api`)
//! - Bundle VFS resolution (`frontendRoot`-aware)
//! - TypeScript / JSX source parsing (`SourceType::tsx()`)

use std::collections::HashSet;

use oxc_allocator::Allocator;
use oxc_ast::ast as ox;
use oxc_ast_visit::Visit;
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType};

struct Edit {
    start: u32,
    end: u32,
    text: String,
}

pub struct LinkedGraph {
    pub source: String,
    pub module_count: usize,
    pub failures: Vec<(String, String)>,
}

#[derive(Default)]
struct DynamicScan {
    dyn_imports: Vec<(u32, u32, u32, u32)>,
    meta_spans: Vec<(u32, u32)>,
}

impl<'a> Visit<'a> for DynamicScan {
    fn visit_import_expression(&mut self, it: &ox::ImportExpression<'a>) {
        let span = it.span();
        let arg = it.source.span();
        self.dyn_imports
            .push((span.start, span.end, arg.start, arg.end));
        oxc_ast_visit::walk::walk_import_expression(self, it);
    }

    fn visit_meta_property(&mut self, it: &ox::MetaProperty<'a>) {
        if it.meta.name == "import" {
            let span = it.span();
            self.meta_spans.push((span.start, span.end));
        }
        oxc_ast_visit::walk::walk_meta_property(self, it);
    }
}

struct Rewritten {
    body: String,
    deps: Vec<String>,
    export_calls: Vec<String>,
}

fn js_string(s: &str) -> String {
    format!(
        "\"{}\"",
        s.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
    )
}

fn source_type_for(path: &str) -> SourceType {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".tsx") {
        SourceType::tsx()
    } else if lower.ends_with(".ts") {
        SourceType::ts()
    } else if lower.ends_with(".jsx") {
        SourceType::jsx()
    } else {
        SourceType::mjs()
    }
}

fn rewrite_module(
    url: &str,
    source: &str,
    resolve: &dyn Fn(&str, &str) -> String,
) -> Result<Rewritten, String> {
    let allocator = Allocator::default();
    let ret = Parser::new(&allocator, source, source_type_for(url)).parse();
    if !ret.errors.is_empty() {
        return Err(format!("{}", ret.errors[0]));
    }
    let program = &ret.program;

    let mut edits: Vec<Edit> = Vec::new();
    let mut deps: Vec<String> = Vec::new();
    let mut export_calls: Vec<String> = Vec::new();
    let add_dep = |spec: &str, deps: &mut Vec<String>| -> String {
        let abs = resolve(url, spec);
        if !deps.contains(&abs) {
            deps.push(abs.clone());
        }
        abs
    };

    for stmt in &program.body {
        match stmt {
            ox::Statement::ImportDeclaration(d) => {
                // Skip TypeScript `import type ...` declarations completely
                if d.import_kind.is_type() {
                    let span = d.span();
                    edits.push(Edit {
                        start: span.start,
                        end: span.end,
                        text: String::new(),
                    });
                    continue;
                }
                let span = d.span();
                let abs = add_dep(&d.source.value, &mut deps);
                let mut out = String::new();
                let mut named: Vec<String> = Vec::new();
                let mut tail = String::new();
                if let Some(specs) = &d.specifiers {
                    for s in specs {
                        match s {
                            ox::ImportDeclarationSpecifier::ImportDefaultSpecifier(x) => {
                                named.push(format!("default:{}", x.local.name));
                            }
                            ox::ImportDeclarationSpecifier::ImportNamespaceSpecifier(x) => {
                                tail.push_str(&format!(
                                    "const {}=__imp({});",
                                    x.local.name,
                                    js_string(&abs)
                                ));
                            }
                            ox::ImportDeclarationSpecifier::ImportSpecifier(x) => {
                                if x.import_kind.is_type() {
                                    continue;
                                }
                                let imported = match &x.imported {
                                    ox::ModuleExportName::IdentifierName(i) => i.name.to_string(),
                                    ox::ModuleExportName::IdentifierReference(i) => {
                                        i.name.to_string()
                                    }
                                    ox::ModuleExportName::StringLiteral(l) => l.value.to_string(),
                                };
                                named.push(format!("{}:{}", js_string(&imported), x.local.name));
                            }
                        }
                    }
                }
                if named.is_empty() && tail.is_empty() {
                    out.push_str(&format!("__imp({});", js_string(&abs)));
                } else if !named.is_empty() {
                    out.push_str(&format!(
                        "const{{{}}}=__imp({});",
                        named.join(","),
                        js_string(&abs)
                    ));
                }
                out.push_str(&tail);
                edits.push(Edit {
                    start: span.start,
                    end: span.end,
                    text: out,
                });
            }
            ox::Statement::ExportNamedDeclaration(d) => {
                if d.export_kind.is_type() {
                    let span = d.span();
                    edits.push(Edit {
                        start: span.start,
                        end: span.end,
                        text: String::new(),
                    });
                    continue;
                }
                let span = d.span();
                if let Some(src) = &d.source {
                    let abs = add_dep(&src.value, &mut deps);
                    for s in &d.specifiers {
                        let local = match &s.local {
                            ox::ModuleExportName::IdentifierName(i) => i.name.to_string(),
                            ox::ModuleExportName::IdentifierReference(i) => i.name.to_string(),
                            ox::ModuleExportName::StringLiteral(l) => l.value.to_string(),
                        };
                        let exported = match &s.exported {
                            ox::ModuleExportName::IdentifierName(i) => i.name.to_string(),
                            ox::ModuleExportName::IdentifierReference(i) => i.name.to_string(),
                            ox::ModuleExportName::StringLiteral(l) => l.value.to_string(),
                        };
                        export_calls.push(format!(
                            "__exp({},()=>__imp({})[{}]);",
                            js_string(&exported),
                            js_string(&abs),
                            js_string(&local)
                        ));
                    }
                    edits.push(Edit {
                        start: span.start,
                        end: span.end,
                        text: String::new(),
                    });
                } else if let Some(decl) = &d.declaration {
                    // Strip ONLY the leading `export ` prefix so inner `import.meta` / `import()`
                    // edits inside the declaration body never overlap this edit span.
                    let dspan = decl.span();
                    for name in declared_names(decl) {
                        export_calls.push(format!("__exp({},()=>{});", js_string(&name), name));
                    }
                    edits.push(Edit {
                        start: span.start,
                        end: dspan.start,
                        text: String::new(),
                    });
                } else {
                    for s in &d.specifiers {
                        let local = match &s.local {
                            ox::ModuleExportName::IdentifierName(i) => i.name.to_string(),
                            ox::ModuleExportName::IdentifierReference(i) => i.name.to_string(),
                            ox::ModuleExportName::StringLiteral(l) => l.value.to_string(),
                        };
                        let exported = match &s.exported {
                            ox::ModuleExportName::IdentifierName(i) => i.name.to_string(),
                            ox::ModuleExportName::IdentifierReference(i) => i.name.to_string(),
                            ox::ModuleExportName::StringLiteral(l) => l.value.to_string(),
                        };
                        export_calls.push(format!("__exp({},()=>{});", js_string(&exported), local));
                    }
                    edits.push(Edit {
                        start: span.start,
                        end: span.end,
                        text: String::new(),
                    });
                }
            }
            ox::Statement::ExportDefaultDeclaration(d) => {
                let span = d.span();
                // Rewrite ONLY the prefix/suffix around the declaration/expression so inner
                // `import.meta` and `import()` edits never overlap with the outer export span.
                match &d.declaration {
                    ox::ExportDefaultDeclarationKind::FunctionDeclaration(f) => {
                        let fspan = f.span();
                        match &f.id {
                            Some(id) => {
                                export_calls.push(format!("__exp(\"default\",()=>{});", id.name));
                                edits.push(Edit {
                                    start: span.start,
                                    end: fspan.start,
                                    text: String::new(),
                                });
                            }
                            None => {
                                export_calls
                                    .push("__exp(\"default\",()=>__zippDefault);".into());
                                edits.push(Edit {
                                    start: span.start,
                                    end: fspan.start,
                                    text: "const __zippDefault=".into(),
                                });
                                edits.push(Edit {
                                    start: fspan.end,
                                    end: span.end,
                                    text: ";".into(),
                                });
                            }
                        }
                    }
                    ox::ExportDefaultDeclarationKind::ClassDeclaration(c) => {
                        let cspan = c.span();
                        match &c.id {
                            Some(id) => {
                                export_calls.push(format!("__exp(\"default\",()=>{});", id.name));
                                edits.push(Edit {
                                    start: span.start,
                                    end: cspan.start,
                                    text: String::new(),
                                });
                            }
                            None => {
                                export_calls
                                    .push("__exp(\"default\",()=>__zippDefault);".into());
                                edits.push(Edit {
                                    start: span.start,
                                    end: cspan.start,
                                    text: "const __zippDefault=".into(),
                                });
                                edits.push(Edit {
                                    start: cspan.end,
                                    end: span.end,
                                    text: ";".into(),
                                });
                            }
                        }
                    }
                    other => {
                        let ospan = other.span();
                        export_calls.push("__exp(\"default\",()=>__zippDefault);".into());
                        edits.push(Edit {
                            start: span.start,
                            end: ospan.start,
                            text: "const __zippDefault=(".into(),
                        });
                        edits.push(Edit {
                            start: ospan.end,
                            end: span.end,
                            text: ");".into(),
                        });
                    }
                }
            }
            ox::Statement::ExportAllDeclaration(d) => {
                let span = d.span();
                let abs = add_dep(&d.source.value, &mut deps);
                let out = match &d.exported {
                    Some(name) => {
                        let exported = match name {
                            ox::ModuleExportName::IdentifierName(i) => i.name.to_string(),
                            ox::ModuleExportName::IdentifierReference(i) => i.name.to_string(),
                            ox::ModuleExportName::StringLiteral(l) => l.value.to_string(),
                        };
                        export_calls.push(format!(
                            "__exp({},()=>__imp({}));",
                            js_string(&exported),
                            js_string(&abs)
                        ));
                        String::new()
                    }
                    None => format!("__expAll(__imp({}));", js_string(&abs)),
                };
                edits.push(Edit {
                    start: span.start,
                    end: span.end,
                    text: out,
                });
            }
            _ => {}
        }
    }

    let mut scan = DynamicScan::default();
    scan.visit_program(program);
    for (start, end, arg_start, arg_end) in scan.dyn_imports {
        let arg_text = source
            .get(arg_start as usize..arg_end as usize)
            .unwrap_or("");
        match syn_literal(arg_text) {
            Some(spec) => {
                let abs = resolve(url, &spec);
                deps.push(abs.clone());
                edits.push(Edit {
                    start,
                    end,
                    text: format!("__dyn({})", js_string(&abs)),
                });
            }
            None => {
                // Replace only the `import(` prefix and trailing `)` so nested `import.meta` or
                // `import(...)` inside the specifier expression stay valid and non-overlapping.
                edits.push(Edit {
                    start,
                    end: arg_start,
                    text: format!("__dynRel({},", js_string(url)),
                });
                edits.push(Edit {
                    start: arg_end,
                    end,
                    text: ")".into(),
                });
            }
        }
    }
    for (start, end) in scan.meta_spans {
        edits.push(Edit {
            start,
            end,
            text: "__meta".into(),
        });
    }

    edits.sort_by(|a, b| b.start.cmp(&a.start).then_with(|| b.end.cmp(&a.end)));
    let mut body = source.to_string();
    let mut last_start = usize::MAX;
    for e in edits {
        let s = e.start as usize;
        let end = e.end as usize;
        if s > end || end > body.len() || end > last_start {
            continue;
        }
        if !body.is_char_boundary(s) || !body.is_char_boundary(end) {
            continue;
        }
        body.replace_range(s..end, &e.text);
        last_start = s;
    }

    Ok(Rewritten {
        body,
        deps,
        export_calls,
    })
}

fn syn_literal(text: &str) -> Option<String> {
    let t = text.trim();
    let b = t.as_bytes();
    if b.len() >= 2
        && ((b[0] == b'"' && b[b.len() - 1] == b'"')
            || (b[0] == b'\'' && b[b.len() - 1] == b'\'')
            || (b[0] == b'`' && b[b.len() - 1] == b'`'))
    {
        let inner = &t[1..t.len() - 1];
        if b[0] == b'`' && inner.contains("${") {
            return None;
        }
        if inner.contains(['"', '\'', '`', '\\']) {
            return None;
        }
        return Some(inner.to_string());
    }
    None
}

fn declared_names<'a>(decl: &ox::Declaration<'a>) -> Vec<String> {
    let mut out = Vec::new();
    match decl {
        ox::Declaration::VariableDeclaration(d) => {
            for dd in &d.declarations {
                collect_pattern_names(&dd.id, &mut out);
            }
        }
        ox::Declaration::FunctionDeclaration(f) => {
            if let Some(id) = &f.id {
                out.push(id.name.to_string());
            }
        }
        ox::Declaration::ClassDeclaration(c) => {
            if let Some(id) = &c.id {
                out.push(id.name.to_string());
            }
        }
        _ => {}
    }
    out
}

fn collect_pattern_names<'a>(pat: &ox::BindingPattern<'a>, out: &mut Vec<String>) {
    match pat {
        ox::BindingPattern::BindingIdentifier(id) => out.push(id.name.to_string()),
        ox::BindingPattern::ObjectPattern(o) => {
            for prop in &o.properties {
                collect_pattern_names(&prop.value, out);
            }
            if let Some(rest) = &o.rest {
                collect_pattern_names(&rest.argument, out);
            }
        }
        ox::BindingPattern::ArrayPattern(a) => {
            for elem in a.elements.iter().flatten() {
                collect_pattern_names(elem, out);
            }
            if let Some(rest) = &a.rest {
                collect_pattern_names(&rest.argument, out);
            }
        }
        ox::BindingPattern::AssignmentPattern(ap) => collect_pattern_names(&ap.left, out),
    }
}

/// Link one or more ES module entries into a single classic script runnable by `zipp-vm`.
/// Any `softn:*` specifier resolves directly to `globalThis.__softnBuiltins[spec]` at runtime.
pub fn link_modules(
    entries: &[(String, String)],
    resolve: &dyn Fn(&str, &str) -> String,
    fetch: &dyn Fn(&str) -> Result<String, String>,
) -> LinkedGraph {
    let mut visited: HashSet<String> = HashSet::new();
    let mut queue: Vec<(String, Option<String>)> = entries
        .iter()
        .map(|(url, src)| (url.clone(), Some(src.clone())))
        .collect();
    let mut defs: Vec<String> = Vec::new();
    let mut failures: Vec<(String, String)> = Vec::new();
    let mut count = 0usize;

    while let Some((url, inline_src)) = queue.pop() {
        if url.starts_with("softn:") {
            continue;
        }
        if !visited.insert(url.clone()) {
            continue;
        }
        let source = match inline_src {
            Some(s) => s,
            None => match fetch(&url) {
                Ok(s) => s,
                Err(e) => {
                    failures.push((url, e));
                    continue;
                }
            },
        };
        let rewritten = match rewrite_module(&url, &source, resolve) {
            Ok(r) => r,
            Err(e) => {
                failures.push((url, e));
                continue;
            }
        };
        for dep in rewritten.deps {
            if !dep.starts_with("softn:") && !visited.contains(&dep) {
                queue.push((dep, None));
            }
        }
        let exports_prefix = rewritten.export_calls.join("");
        defs.push(format!(
            "__zippDef({},function(__imp,__exp,__expAll,__dyn,__dynRel,__meta){{{}\n{}\n}});",
            js_string(&url),
            exports_prefix,
            rewritten.body
        ));
        count += 1;
    }

    let mut out = String::new();
    out.push_str(MODULE_RUNTIME);
    for d in defs {
        out.push_str(&d);
        out.push('\n');
    }
    for (url, _) in entries {
        out.push_str(&format!("__zippImp({});\n", js_string(url)));
    }

    LinkedGraph {
        source: out,
        module_count: count,
        failures,
    }
}

const MODULE_RUNTIME: &str = r#"
var __zippModDefs = {};
var __zippModCache = {};
function __zippDef(url, fn) { __zippModDefs[url] = fn; }
function __zippImp(url) {
  if (url && url.indexOf("softn:") === 0) {
    if (typeof __softnBuiltins === "object" && __softnBuiltins && __softnBuiltins[url]) {
      return __softnBuiltins[url];
    }
    throw new Error("Unknown SoftN built-in module: " + url);
  }
  if (__zippModCache[url]) return __zippModCache[url];
  var fn = __zippModDefs[url];
  if (!fn) throw new Error("Module not found in bundle: " + url);
  var ns = {};
  __zippModCache[url] = ns;
  function __exp(name, getter) {
    Object.defineProperty(ns, name, { enumerable: true, configurable: true, get: getter });
  }
  function __expAll(fromNs) {
    if (!fromNs) return;
    var keys = Object.keys(fromNs);
    for (var i = 0; i < keys.length; i++) {
      (function (k) {
        if (k === "default") return;
        Object.defineProperty(ns, k, { enumerable: true, configurable: true, get: function () { return fromNs[k]; } });
      })(keys[i]);
    }
  }
  function __dyn(target) {
    return new Promise(function (resolve, reject) {
      try { resolve(__zippImp(target)); } catch (e) { reject(e); }
    });
  }
  function __dynRel(base, spec) {
    return __dyn(spec);
  }
  fn(__zippImp, __exp, __expAll, __dyn, __dynRel, { url: url });
  return ns;
}
"#;
