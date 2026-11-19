import { createAppHost } from "./host/bridge.ts";
import { mountTaskReview } from "./task-review.ts";

const app = createAppHost("Hetu Luoshu task view");
const view = mountTaskReview(app, document.getElementById("app")!);
if (window.parent === window) view.failed();
else void app.connect().then(() => view.ready()).catch(error => view.failed(error));
