import type { Attachment } from '~/types/chat'

/** The one image viewer (ui/ImageViewer.vue, mounted in app.vue): what it shows. */
export const imageViewer = reactive({
  open: false,
  images: [] as Attachment[],
  index: 0,
})

/** Show `images[index]` large; the others are a keypress away. */
export function openImage(images: Attachment[], index = 0) {
  if (!images.length) return
  imageViewer.images = images
  imageViewer.index = Math.max(0, Math.min(index, images.length - 1))
  imageViewer.open = true
}

export function closeImage() {
  imageViewer.open = false
}
