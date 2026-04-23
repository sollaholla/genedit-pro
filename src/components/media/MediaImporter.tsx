import { forwardRef, useImperativeHandle, useRef } from 'react';
import { useMediaStore } from '@/state/mediaStore';

export type MediaImporterHandle = {
  openPicker: () => void;
};

export const MediaImporter = forwardRef<MediaImporterHandle>(function MediaImporter(_props, ref) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const importFiles = useMediaStore((s) => s.importFiles);

  useImperativeHandle(ref, () => ({
    openPicker: () => inputRef.current?.click(),
  }));

  return (
    <input
      ref={inputRef}
      type="file"
      accept="video/*,audio/*,image/*"
      multiple
      className="hidden"
      onChange={async (e) => {
        const files = e.target.files ? Array.from(e.target.files) : [];
        if (files.length > 0) await importFiles(files);
        if (inputRef.current) inputRef.current.value = '';
      }}
    />
  );
});
