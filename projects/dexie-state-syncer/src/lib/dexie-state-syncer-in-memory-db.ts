import { primitive } from "./dexie-state-syncer-reducer";
import { StateDescriptor, StateNode, StateObjectDatabase } from './dexie-state-syncer-db';
import Dexie from "dexie";


export class StateObjectInMemoryDatabase extends StateObjectDatabase {
  private nodes: Map<number, StateNode> | any;

  constructor() {
    super();
    this.nodes = new Map<number, StateNode>();
    this.on('populate', () => this.populate());
  }

  override async clear() {
    await Promise.resolve(this.nodes.clear());
  }

  override async populate() {

  }

  override async get(key: number): Promise<StateNode | undefined>  {
    return Promise.resolve(this.nodes.get(key));
  }

  override async set(node: StateNode): Promise<number> {
    return Promise.resolve(this.nodes.set(node.id!, node).get(node.id!)?.id!);
  }

  override async update(node: StateNode): Promise<number> {
    return Promise.resolve(this.nodes.set(node.id!, node).get(node.id!)?.id!);
  }

  override async remove(key: number): Promise<void> {
    this.nodes.delete(key);
    return Promise.resolve();
  }

  override async toArray(): Promise<StateNode[]> {
    return Promise.resolve([...this.nodes.values()]);
  }

  override transaction(...args: any[]): any {
      return (args[2] as any)();
  }

  override get stateNodes(): any {
    return [...this.nodes.values()]
  };

  override set stateNodes(table: Dexie.Table<StateNode, number>) {
    Function.prototype
  };
}

export class InMemoryObjectState {
  db: StateObjectDatabase;
  root: number | undefined;
  autoincrement: number;

  constructor(descriptor?: StateDescriptor) {
    this.db = new StateObjectInMemoryDatabase();
    this.root = descriptor?.root;
    this.autoincrement = descriptor?.autoincrement ?? 0;
  }

  descriptor(): StateDescriptor {
    return { autoincrement: this.autoincrement, root: this.root, date: Date.now(),
      reader: {
        get: (path) => this.get(Array.isArray(path) ? path.join('.') : path),
        find: (path) => this.find(Array.isArray(path) ? path.join('.') : path)
      },
      writer: {
        initialize: (obj) => this.initialize(obj),
        update: (path, value) => this.update(Array.isArray(path) ? path.join('.') : path, value),
      }
    };
  }

  rootId(): number | undefined {
    return this.root;
  }

  async leaf(id: number): Promise<boolean> {
    try {
      return await this.db.transaction('r', this.db.stateNodes, async () => {
        let nodeValue = await this.db.get(id);
        return nodeValue?.left === undefined;
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async createNode(key: string, data: any, parent: number | undefined): Promise<StateNode | undefined> {

    try {
      return await this.db.transaction('rw', this.db.stateNodes, async () => {
        if (parent === undefined) {
          if (this.root !== undefined) return undefined;
          const newNodeId = await this.db.set({
            id: this.autoincrement,
            key: 'root',
            left: undefined,
            right: undefined,
            parent: undefined,
            data: undefined,
          });

          const newNode = await this.db.get(newNodeId);

          this.root = this.autoincrement;
          this.autoincrement++;
          return newNode;
        }

        let parentNode = await this.db.get(parent);
        if (parentNode === undefined) return undefined;

        const newNodeId_1 = await this.db.set({
          id: this.autoincrement,
          key: key,
          left: undefined,
          right: undefined,
          parent: parent,
          data: primitive(data) ? data : undefined,
        });

        const newNode_1 = await this.db.get(this.autoincrement);

        this.autoincrement++;
        if (parentNode.left === undefined) {
          parentNode.left = newNode_1?.id!;
        } else {
          let siblingNode = await this.db.get(parentNode.left);
          while (siblingNode !== undefined && siblingNode.right !== undefined) {
            siblingNode = await this.db.get(siblingNode.right);
          }
          if (siblingNode !== undefined) {
            siblingNode.right = newNode_1?.id!;
          }
        }
        return newNode_1;
      });
    } catch (err) {
      return Promise.reject();
    }
  }

  async getNode(id: number): Promise<StateNode | undefined> {
    try {
      return await this.db.transaction('r', this.db.stateNodes, async () => {
        return await this.db.get(id);
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async getChildNodes(id: number): Promise<StateNode[] | undefined> {
    try {
      return await this.db.transaction('r', this.db.stateNodes, async () => {
        const node = await this.db.get(id);

        if (node && node.left) {
          let children = [], left = await this.db.get(node.left)!;
          while (left?.right !== undefined) {
            children.push(left);
            left = await this.db.get(left.right)!;
          }

          return children;
        }

        return undefined;
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async deleteNode(id: number) {
    try {
      return await this.db.transaction('rw', this.db.stateNodes, async () => {
        let node = await this.db.get(id);
        if (node === undefined) return;

        if (node.left !== undefined) {
          let left = await this.db.get(node.left)!;

          while (left?.right !== undefined) {
            let right = await this.db.get(left.right)!;
            this.deleteNode(left.id!);
            left = right;
          }
          if(left) { this.deleteNode(left.id!); }
          await this.db.set({ ...node, left: undefined });
        }

        if (node.parent === undefined) {
          await this.db.remove(node.id!);
          this.root = undefined;
        } else {
          let parentNode = await this.db.get(node.parent);
          if (parentNode !== undefined && parentNode.left === node.id) {
            await this.db.remove(node.id!);
            parentNode.left = node.right;
          } else {
            let siblingNode = await this.db.get(parentNode?.left as number);
            while (siblingNode !== undefined && siblingNode.right !== node.id) {
              siblingNode = await this.db.get(siblingNode.right as number);
            }
            if (siblingNode !== undefined) {
              await this.db.remove(node.id!);
              siblingNode.right = node.right;
            }
          }
        }
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async updateNode(nodeId: number, updates: { left?: number; right?: number; parent?: number; }): Promise<StateNode | undefined> {
    try {
      // Access the node by its ID and update the necessary properties
      return await this.db.transaction('rw', this.db.stateNodes, async () => {
        let node = await this.db.get(nodeId);
        if (node) {
          // Update the node's properties with the provided updates
          node = { ...node, ...updates };
          await this.db.update(node);
          return await this.db.get(nodeId);
        } else {
          throw new Error(`Node with ID ${nodeId} not found`);
        }
      });
    } catch (err) {
      throw err;
    }
  }

  async touchNode(id: number, updates: { left?: number; right?: number; parent?: number; }): Promise<StateNode | undefined> {
    try {
      return await this.db.transaction('rw', this.db.stateNodes, async () => {
        let node = await this.db.get(id);
        if (!node) {
          throw new Error('Node not found');
        }
        let newNode: StateNode = {
          ...node,
          ...updates,
          id: this.autoincrement // Assign a new ID from autoincrement
        };

        // Save the new node to the database with the new ID
        await this.db.set(newNode);

        // If the node is the root, update the root reference
        if (node.parent === undefined) {
          this.root = this.autoincrement; // The new node is now the root
        } else {
          // Update the parent's reference to the new node
          let parentNode = await this.db.get(node.parent);
          if (parentNode && parentNode.left === node.id) {
            parentNode.left = this.autoincrement;
            await this.db.set(parentNode); // Save the updated parent node
          } else {
            let current = parentNode && parentNode.left ? await this.db.get(parentNode.left) : undefined;
            while (current && current.right && current.right !== node.id) {
              current = await this.db.get(current.right);
            }
            if (current) {
              current.right = this.autoincrement;
              await this.db.set(current); // Save the updated sibling node
            }
          }
        }

        // Remove the old node from the database
        await this.db.remove(node.id!);

        // Increment the autoincrement value for the next node
        this.autoincrement++;

        return newNode; // Return the new node
      });
    } catch (err) {
      console.error(err);
      return Promise.reject(err);
    }
  }

  async getData(node: StateNode): Promise<any> {
    try {
      return await this.db.transaction('r', this.db.stateNodes, async () => {
        if (node === undefined) {
          throw new Error("Tree node cannot be undefined");
        }

        let data = node.left ? {} : node.data;

        if (node.left !== undefined) {
          let left = await this.db.get(node.left) as StateNode | undefined;
          while (left !== undefined) {
            data[left.key] = await this.getData(left);
            left = left.right ? await this.db.get(left.right) : undefined;
          }
        }

        return data;
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }


  async initialize(obj: any): Promise<StateNode | undefined> {
    try {
      return await this.db.transaction('rw', this.db.stateNodes, async () => {
        this.root = undefined;
        this.autoincrement = 0;
        await this.db.clear();

        const rootNode = await this.createNode('root', undefined, undefined);
        const root = rootNode?.id;

        let queue = [{ obj: obj, parent: root, previousSibling: undefined }];

        while (queue.length > 0) {
          let { obj, parent, previousSibling } = queue.shift() as { obj: any; parent: number | undefined; previousSibling: number | undefined };
          let firstChild = undefined;

          for (const key in obj) {
            const value = obj[key];
            const record = await this.createNode(key, value, parent);
            if (!record) {
              throw new Error('Failed to create a node');
            }

            if (!firstChild) {
              firstChild = record.id;
              // Retrieve the parent node from the database, update it, and save it back
              let parentNode = await this.db.get(parent!);
              if (parentNode) {
                parentNode.left = firstChild;
                await this.db.set(parentNode);
              }
            } else {
              // Retrieve the previous sibling from the database, update it, and save it back
              let prevSiblingNode = await this.db.get(previousSibling!);
              if (prevSiblingNode) {
                prevSiblingNode.right = record.id;
                await this.db.set(prevSiblingNode);
              }
            }

            previousSibling = record.id;

            if (typeof value === 'object') {
              queue.push({ obj: value, parent: record.id, previousSibling: undefined });
            }
          }
        }
        return rootNode;
      });
    } catch (err) {
      console.error('Error initializing tree:', err);
      throw err;
    }
  }

  async find(path: string): Promise<StateNode | undefined> {
    try {
      return await this.db.transaction('r', this.db.stateNodes, async () => {
        let node = await this.db.get(this.root!);

        if(typeof path === 'string' && path.length > 0) {
          const split = path.split('.');

          for (const part of split) {
            let nextChild = node && node.left !== undefined ? await this.db.get(node.left) : undefined;
            while (nextChild !== undefined && nextChild.key !== part) {
              nextChild = nextChild.right !== undefined ? await this.db.get(nextChild.right) : undefined;
            }
            return nextChild;
          }
        }

        return node;
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async get(path: string): Promise<any> {
    try {
      return await this.db.transaction('r', this.db.stateNodes, async () => {
        let subtree = await this.find(path);
        return subtree !== undefined ? await this.getData(subtree) : undefined;
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async create(obj: any, path: string) {
    try {
      return await this.db.transaction('rw', this.db.stateNodes, async () => {
        let rootNode = await this.db.get(this.root!);
        let node = rootNode !== undefined ? await this.touchNode(rootNode.id!, {}) : await this.createNode('root', undefined, undefined);

        if(typeof path === 'string' && path.length > 0) {
          const split = path.split('.');

          let parent = node;
          for (const part of split) {
            let child = parent?.left ? await this.db.get(parent.left) : undefined;
            let nextChild = child;

            while (nextChild !== undefined && nextChild.key !== part) {
              nextChild = nextChild.right === undefined ? undefined : await this.db.get(nextChild.right);
            }

            if (nextChild === undefined) {
              nextChild = parent && await this.createNode(part, undefined, parent.id);
            } else {
              nextChild = await this.touchNode(nextChild.id!, {});
            }

            parent = nextChild;
          }


          let queue = [];
          queue.push({obj: obj, parent: parent?.id});

          while(queue.length > 0) {
            let { obj, parent } = queue.shift() as {obj: any; parent: number | undefined};
            if(typeof obj === 'object') {
              for (let key in obj) {

                let value = obj[key];
                let record = await this.createNode(key, value, parent)!;


                if (typeof value === "object" && record !== undefined) {

                  queue.push({obj: value, parent: record.id});
                }
              }
            }
          }
        }
        return node;
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async update(path: string, obj: any) {
    try {
      return await this.db.transaction('rw', this.db.stateNodes, async () => {
        await this.delete(path);
        return await this.create(obj, path);
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async delete(path: string) {
    try {
      return await this.db.transaction('rw', this.db.stateNodes, async () => {
        let subtreeRoot = await this.find(path);
        if(subtreeRoot === undefined) { return undefined; }

        const parent = subtreeRoot.parent ? await this.db.get(subtreeRoot.parent) : undefined;

        if (parent) {
          if (parent.left === subtreeRoot.id) {
            parent.left = subtreeRoot.right;
            await this.updateNode(parent.id!, {left: parent.left}); // Update the parent in the database
          } else {
            let current = parent.left ? await this.db.get(parent.left) : undefined;
            while (current && current.right && current.right !== subtreeRoot.id) {
              current = await this.db.get(current.right);
            }
            if (current) {
              current.right = subtreeRoot.right;
              await this.updateNode(current.id!, {right: current.right}); // Update the current node in the database
            }
          }
        }

        await this.recursivelyDeleteSubtree(subtreeRoot.id); // Await the deletion of the subtree
        return true;
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }


  async recursivelyDeleteSubtree(nodeId: number | undefined) {
    try {
      await this.db.transaction('rw', this.db.stateNodes, async () => {
        if (nodeId === undefined) {
          return;
        }
        const node = await this.db.get(nodeId);
        if (node) {
          if (node.left !== undefined) {
            await this.recursivelyDeleteSubtree(node.left);
          }
          if (node.right !== undefined) {
            await this.recursivelyDeleteSubtree(node.right);
          }

          await this.deleteNode(nodeId);
        }
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }
}
