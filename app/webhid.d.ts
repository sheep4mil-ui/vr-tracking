interface HIDDevice extends EventTarget {
  opened: boolean;
  productId: number;
  open(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
}
interface HIDInputReportEvent extends Event {
  readonly data: DataView;
  readonly reportId: number;
}
interface HID {
  requestDevice(options: { filters: Array<{ vendorId: number; productId?: number }> }): Promise<HIDDevice[]>;
}
interface Navigator { readonly hid: HID; }
