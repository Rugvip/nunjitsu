#![cfg_attr(target_arch = "wasm32", no_std)]

mod template;

#[cfg(target_arch = "wasm32")]
mod wasm;

pub use template::{RenderError, RenderedValue, render_template};

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}
