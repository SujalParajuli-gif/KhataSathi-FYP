export type EsewaInitiationResponse = {
  paymentId: string;
  invoiceId: string;
  invoiceNo: string;
  amount: number;
  formAction: string;
  fields: Record<string, string>;
};

export function submitEsewaForm(
  formAction: string,
  fields: Record<string, string>,
) {
  if (typeof document === "undefined") return;

  const form = document.createElement("form");
  form.method = "POST";
  form.action = formAction;
  form.style.display = "none";

  Object.entries(fields).forEach(([name, value]) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  });

  document.body.appendChild(form);
  form.submit();
}
