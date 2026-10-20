// House has two themes; follow the device, set before first paint
document.documentElement.dataset.theme =
  matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
