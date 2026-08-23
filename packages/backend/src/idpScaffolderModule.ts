import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createIdpProvisionServiceAction } from './idpProvisionServiceAction';

export default createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'idp-provision-service',
  register(reg) {
    reg.registerInit({
      deps: { scaffolder: scaffolderActionsExtensionPoint },
      async init({ scaffolder }) {
        scaffolder.addActions(createIdpProvisionServiceAction());
      },
    });
  },
});
