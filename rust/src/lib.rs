#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(any(target_arch = "wasm32", test))]
mod expression;
mod template;

#[cfg(target_arch = "wasm32")]
mod wasm;

pub use template::{RenderError, RenderedValue, TemplateItem, next_item, render_template};

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}
