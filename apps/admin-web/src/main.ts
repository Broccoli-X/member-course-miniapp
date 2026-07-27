import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import App from './App.vue';
import router from './router';
import { installTokenProvider } from './stores/auth';

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);

// Wire the auth store into the http layer (refresh-on-401, token reads) now
// that Pinia is active — before the router and any request can fire.
installTokenProvider();

app.use(router);
app.use(ElementPlus);

app.mount('#app');
